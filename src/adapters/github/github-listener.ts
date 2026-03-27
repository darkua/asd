import type {
  FeedbackListener,
  RawFeedbackHandler,
  StatusHandler,
  TaskRunRequestHandler,
} from "../../ports/feedback-listener.js";
import type { TaskQueryStore } from "../../ports/store.js";
import type { StoredTask } from "../../ports/types.js";
import { GitHubClient } from "./github-client.js";
import { GitHubWebhookHandler, type WebhookEventHandler } from "./github-webhook-handler.js";
import type { GitHubWebhookPayload, GitHubComment, GitHubReview, GitHubReviewComment, PrRef } from "./github-types.js";
import { createLogger } from "../../logger.js";
import { toErrorMessage } from "../../utils/errors.js";
import { GITHUB_BOT_SIGNATURE, GITHUB_CODERABBIT_USERNAME, GITHUB_MAX_STATUS_COMMENT_LENGTH, GITHUB_REVIEW_ACK_MESSAGE, CANCEL_COMMANDS } from "../../constants.js";
import { cleanReviewBody, cleanCommentBody } from "./review-cleaner.js";

const log = createLogger();


export interface GitHubListenerConfig {
  botUsername: string;
  webhookSecret: string;
}

export class GitHubListener implements FeedbackListener {
  private feedbackHandler: RawFeedbackHandler | null = null;
  private statusHandler: StatusHandler | null = null;
  private readonly webhookHandler: GitHubWebhookHandler;

  constructor(
    private readonly client: GitHubClient,
    private readonly store: TaskQueryStore,
    private readonly config: GitHubListenerConfig,
  ) {
    const onEvent: WebhookEventHandler = (eventType, payload) => this.handleEvent(eventType, payload);
    this.webhookHandler = new GitHubWebhookHandler(onEvent, config.webhookSecret);
  }

  /** Expose the webhook handler for registration on HealthServer. */
  get webhook(): GitHubWebhookHandler {
    return this.webhookHandler;
  }

  onFeedback(handler: RawFeedbackHandler): void {
    this.feedbackHandler = handler;
  }

  onStatusRequest(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  // GitHub comments/reviews do not initiate manual "start task by JIRA key/link" runs.
  onTaskRunRequest(_handler: TaskRunRequestHandler): void {}

  async start(): Promise<void> {
    log.info("GitHub listener ready (webhook-based)");
  }

  async stop(): Promise<void> {
    // No-op — webhook handler is passive
  }

  // ─── Event Routing ───────────────────────────────────────

  private handleEvent(eventType: string, payload: GitHubWebhookPayload): void {
    if (eventType === "pull_request_review" && payload.action === "submitted") {
      log.info(`GitHub webhook: pull_request_review submitted by ${payload.review?.user?.login}`);
      this.processReview(payload).catch((err) => {
        log.warn(`Error processing GitHub review: ${toErrorMessage(err)}`);
      });
      return;
    }

    if ((eventType === "issue_comment" || eventType === "pull_request_review_comment") && payload.action === "created") {
      log.info(`GitHub webhook: ${eventType} by ${payload.comment?.user?.login}`);
      this.processComment(eventType, payload).catch((err) => {
        log.warn(`Error processing GitHub comment: ${toErrorMessage(err)}`);
      });
      return;
    }

    log.debug(`Ignoring GitHub event: ${eventType} action=${payload.action}`);
  }

  // ─── PR Review Handling ──────────────────────────────────

  private async processReview(payload: GitHubWebhookPayload): Promise<void> {
    const review = payload.review;
    if (!review) return;

    // Self-loop prevention
    if (review.body?.includes(GITHUB_BOT_SIGNATURE)) return;

    const prRef = this.extractPrRef("pull_request_review", payload);
    if (!prRef) return;

    const prUrl = `https://github.com/${prRef.owner}/${prRef.repo}/pull/${prRef.number}`;
    log.info(`GitHub review on PR ${prUrl} by ${review.user.login} (state: ${review.state})`);

    const task = this.findTaskByPrUrl(prUrl);
    if (!task) {
      log.info(`No tracked task for PR ${prUrl}`);
      return;
    }
    log.info(`Matched task ${task.key} (status: ${task.status})`);

    const { feedback, allComments } = await this.buildReviewFeedback(prRef, [review], "PR Review");
    if (!feedback) {
      log.info(`Review on ${task.key} has no actionable comments — skipping`);
      return;
    }
    log.info(`Review feedback for ${task.key}: ${allComments.length} comment(s)`);

    if (!this.feedbackHandler) {
      log.warn("GitHub listener has no feedback handler registered");
      return;
    }

    // Immediately acknowledge in each review comment thread
    await this.ackReviewComments(prRef, allComments);

    // Reply in the review comment thread if there are line comments, otherwise fall back to PR-level
    const replyFn = allComments.length > 0
      ? this.createReviewReplyFn(prRef, allComments[0].id)
      : this.createReplyFn(prRef);

    const onCompleteFn = this.createReviewCompleteFn(prRef, allComments);

    await this.feedbackHandler({
      taskKey: task.key,
      feedback,
      mode: "fix",
      replyFn,
      onCompleteFn,
    });
  }

  // ─── Issue Comment Handling (commands + text feedback) ───

  private async processComment(eventType: string, payload: GitHubWebhookPayload): Promise<void> {
    const comment = payload.comment;
    if (!comment) return;

    // Self-loop prevention
    if (comment.body.includes(GITHUB_BOT_SIGNATURE)) return;
    if (this.shouldIgnoreComment(comment)) {
      log.debug(
        `Ignoring GitHub comment ${comment.id} by ${comment.user.login}: requires @${this.config.botUsername || "bot"} prefix or CodeRabbit author`,
      );
      return;
    }

    const prRef = this.extractPrRef(eventType, payload);
    if (!prRef) {
      log.debug("Could not extract PR reference — not a PR comment?");
      return;
    }

    const prUrl = `https://github.com/${prRef.owner}/${prRef.repo}/pull/${prRef.number}`;
    log.info(`GitHub comment on PR ${prUrl} by ${comment.user.login}`);

    const task = this.findTaskByPrUrl(prUrl);
    if (!task) {
      log.info(`No tracked task for PR ${prUrl}`);
      return;
    }
    log.info(`Matched task ${task.key} (status: ${task.status})`);

    const text = this.stripBotPrefix(comment.body);
    const { feedback, mode, isCommand } = this.parseComment(text);

    if (isCommand && feedback === "status") {
      await this.handleStatusCommand(prRef, task);
      return;
    }

    if (isCommand && feedback === "coderabbit") {
      await this.handleCoderabbitCommand(prRef, task);
      return;
    }

    if (!this.feedbackHandler) {
      log.warn("GitHub listener has no feedback handler registered");
      return;
    }

    // Enrich feedback with file/line context for review comments
    const enrichedFeedback = this.enrichWithFileContext(comment, feedback);

    // Immediately acknowledge in the review comment thread
    if (eventType === "pull_request_review_comment" && comment.id) {
      await this.client.replyToReviewComment(prRef.owner, prRef.repo, prRef.number, comment.id, GITHUB_REVIEW_ACK_MESSAGE);
    }

    // Reply in the review comment thread if this is a review comment, otherwise PR-level
    const replyFn = eventType === "pull_request_review_comment" && comment.id
      ? this.createReviewReplyFn(prRef, comment.id)
      : this.createReplyFn(prRef);

    // Build completion callback for review comments
    const onCompleteFn = eventType === "pull_request_review_comment" && comment.path
      ? this.createReviewCompleteFn(prRef, [{
          id: comment.id,
          body: comment.body,
          path: comment.path,
          line: comment.line ?? null,
          start_line: comment.start_line ?? null,
          user: comment.user,
        }])
      : undefined;

    await this.feedbackHandler({
      taskKey: task.key,
      feedback: enrichedFeedback,
      mode,
      replyFn,
      onCompleteFn,
    });
  }

  // ─── Helpers ─────────────────────────────────────────────

  /** Create a reply function that posts once then edits the same comment. Truncates long messages. */
  private createReplyFn(prRef: PrRef): (text: string) => Promise<void> {
    let commentId: number | null = null;
    return async (text: string): Promise<void> => {
      const truncated = text.length > GITHUB_MAX_STATUS_COMMENT_LENGTH
        ? text.slice(0, GITHUB_MAX_STATUS_COMMENT_LENGTH) + "\n\n…(truncated)"
        : text;
      if (commentId) {
        await this.client.editComment(prRef.owner, prRef.repo, commentId, truncated);
      } else {
        commentId = await this.client.postComment(prRef.owner, prRef.repo, prRef.number, truncated);
      }
    };
  }

  /** Create a reply function that replies in a review comment thread. First call replies, subsequent calls edit. */
  private createReviewReplyFn(prRef: PrRef, reviewCommentId: number): (text: string) => Promise<void> {
    let replyId: number | null = null;
    return async (text: string): Promise<void> => {
      const truncated = text.length > GITHUB_MAX_STATUS_COMMENT_LENGTH
        ? text.slice(0, GITHUB_MAX_STATUS_COMMENT_LENGTH) + "\n\n…(truncated)"
        : text;
      if (replyId) {
        await this.client.editReviewComment(prRef.owner, prRef.repo, replyId, truncated);
      } else {
        replyId = await this.client.replyToReviewComment(prRef.owner, prRef.repo, prRef.number, reviewCommentId, truncated);
      }
    };
  }

  private extractPrRef(eventType: string, payload: GitHubWebhookPayload): PrRef | null {
    const repo = payload.repository;

    if ((eventType === "pull_request_review" || eventType === "pull_request_review_comment") && payload.pull_request) {
      return { owner: repo.owner.login, repo: repo.name, number: payload.pull_request.number };
    }

    if (eventType === "issue_comment" && payload.issue?.pull_request) {
      return { owner: repo.owner.login, repo: repo.name, number: payload.issue.number };
    }

    return null;
  }

  private findTaskByPrUrl(prUrl: string): StoredTask | undefined {
    const normalized = prUrl.replace(/\/$/, "");
    for (const status of ["review", "processing", "failed"] as const) {
      const tasks = this.store.getTasksByStatus(status);
      const match = tasks.find((t) => t.prUrl?.replace(/\/$/, "") === normalized);
      if (match) return match;
    }
    return undefined;
  }

  /** Strip bot username if it's the first word (e.g. "mowafaqa-agent-fe fix: do X" → "fix: do X") */
  private stripBotPrefix(text: string): string {
    const trimmed = text.trim();
    if (!this.config.botUsername) return trimmed;
    const pattern = new RegExp(`^@?${this.config.botUsername}\\s+`, "i");
    return trimmed.replace(pattern, "").trim();
  }

  /**
   * Only trigger on:
   * 1) comments authored by CodeRabbit, or
   * 2) comments that start with @<botUsername>.
   */
  private shouldIgnoreComment(comment: GitHubComment): boolean {
    const author = comment.user.login.toLowerCase();
    if (author === GITHUB_CODERABBIT_USERNAME.toLowerCase()) {
      return false;
    }

    const bot = this.config.botUsername.trim();
    if (!bot) {
      // Without a configured bot username, only CodeRabbit comments are allowed.
      return true;
    }

    const startsWithMention = new RegExp(`^\\s*@${bot}\\b`, "i").test(comment.body);
    return !startsWithMention;
  }

  /** Enrich feedback text with file/line context from review comments. */
  private enrichWithFileContext(comment: GitHubComment, feedback: string): string {
    if (!comment.path) return feedback;

    const lineInfo = comment.start_line && comment.line
      ? `lines ${comment.start_line}-${comment.line}`
      : comment.line
        ? `line ${comment.line}`
        : "";
    const header = lineInfo
      ? `### File: ${comment.path} (${lineInfo})`
      : `### File: ${comment.path}`;

    return `${header}\n${feedback}`;
  }

  private parseComment(text: string): { feedback: string; mode: "fix" | "redo"; isCommand: boolean } {
    const lower = text.toLowerCase().trim();

    const commands: readonly string[] = [...CANCEL_COMMANDS, "retry", "status", "coderabbit"];
    if (commands.includes(lower)) {
      return { feedback: lower, mode: "fix", isCommand: lower === "status" || lower === "coderabbit" };
    }

    if (lower.startsWith("fix:")) {
      return { feedback: text.slice(4).trim(), mode: "fix", isCommand: false };
    }
    if (lower.startsWith("redo:")) {
      return { feedback: text.slice(5).trim(), mode: "redo", isCommand: false };
    }

    // Default: bare text = fix mode
    return { feedback: text, mode: "fix", isCommand: false };
  }

  /** Build structured feedback from one or more reviews + their line comments. */
  private async buildReviewFeedback(
    prRef: PrRef,
    reviews: GitHubReview[],
    title: string,
  ): Promise<{ feedback: string | null; allComments: GitHubReviewComment[] }> {
    const parts: string[] = [];
    const allComments: GitHubReviewComment[] = [];

    for (const review of reviews) {
      if (review.body?.trim()) {
        const cleaned = cleanReviewBody(review.body.trim());
        if (cleaned) parts.push(`## ${title}\n\n${cleaned}`);
      }
      const comments = await this.client.getReviewComments(prRef.owner, prRef.repo, prRef.number, review.id);
      for (const comment of comments) {
        allComments.push(comment);
        const cleanedBody = cleanCommentBody(comment.body);
        if (!cleanedBody) continue;
        const lineInfo = comment.start_line && comment.line
          ? `lines ${comment.start_line}-${comment.line}`
          : comment.line
            ? `line ${comment.line}`
            : "";
        const header = lineInfo
          ? `### File: ${comment.path} (${lineInfo})`
          : `### File: ${comment.path}`;
        parts.push(`${header}\n${cleanedBody}`);
      }
    }

    return {
      feedback: parts.length > 0 ? parts.join("\n\n") : null,
      allComments,
    };
  }

  /** Immediately acknowledge each review comment so the author sees we're working on it. */
  private async ackReviewComments(prRef: PrRef, comments: GitHubReviewComment[]): Promise<void> {
    const results = await Promise.allSettled(
      comments.map((comment) =>
        this.client.replyToReviewComment(
          prRef.owner, prRef.repo, prRef.number, comment.id,
          GITHUB_REVIEW_ACK_MESSAGE,
        ),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        log.warn(`Failed to ack review comment ${comments[i].id}: ${toErrorMessage((results[i] as PromiseRejectedResult).reason)}`);
      }
    }
  }

  /** Create a completion callback that replies to review comments with success/failure. */
  private createReviewCompleteFn(prRef: PrRef, comments: GitHubReviewComment[]): (success: boolean) => Promise<void> {
    return async (success: boolean) => {
      if (success) {
        await this.replyToReviewComments(prRef, comments);
      } else {
        await this.failReviewComments(prRef, comments);
      }
    };
  }

  /** Reply to each review comment confirming feedback failed. */
  private async failReviewComments(prRef: PrRef, comments: GitHubReviewComment[]): Promise<void> {
    const results = await Promise.allSettled(
      comments.map((comment) =>
        this.client.replyToReviewComment(
          prRef.owner, prRef.repo, prRef.number, comment.id,
          "Failed to apply this feedback. Check the PR for details.",
        ),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        log.warn(`Failed to reply failure to review comment ${comments[i].id}: ${toErrorMessage((results[i] as PromiseRejectedResult).reason)}`);
      }
    }
  }

  /** Reply to each review comment confirming it was addressed. */
  private async replyToReviewComments(prRef: PrRef, comments: GitHubReviewComment[]): Promise<void> {
    let commitRef = "latest push";
    try {
      const head = await this.client.getPullRequestHead(prRef.owner, prRef.repo, prRef.number);
      const shortSha = head.sha.slice(0, 7);
      const commitUrl = `https://github.com/${prRef.owner}/${prRef.repo}/commit/${head.sha}`;
      commitRef = `[\`${shortSha}\`](${commitUrl})`;
    } catch (err) {
      log.warn(
        `Could not fetch PR head commit for ${prRef.owner}/${prRef.repo}#${prRef.number}: ${toErrorMessage(err)}`,
      );
    }

    const results = await Promise.allSettled(
      comments.map((comment) => {
        const lineRef = comment.line ? ` (line ${comment.line})` : "";
        const reply = `✅ Addressed in \`${comment.path}\`${lineRef}. See commit ${commitRef}.`;
        return this.client.replyToReviewComment(
          prRef.owner, prRef.repo, prRef.number, comment.id,
          reply,
        );
      }),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        log.warn(`Failed to reply to review comment ${comments[i].id}: ${toErrorMessage(result.reason)}`);
      }
    }
  }

  private async handleStatusCommand(prRef: PrRef, task: StoredTask): Promise<void> {
    const status = this.statusHandler?.();
    const lines = [
      `**Task ${task.key}:** ${task.status}`,
      `Feedback rounds: ${task.feedbackRound}`,
      task.prUrl ? `PR: ${task.prUrl}` : "",
      task.error ? `Error: ${task.error.slice(0, 200)}` : "",
      status ? `\nWorker: processing ${status.processing.length}, queue ${status.queueSize}` : "",
    ].filter(Boolean);

    await this.client.postComment(prRef.owner, prRef.repo, prRef.number, lines.join("\n"));
  }

  private async handleCoderabbitCommand(prRef: PrRef, task: StoredTask): Promise<void> {
    if (!this.feedbackHandler) return;

    const reviews = await this.client.getReviews(prRef.owner, prRef.repo, prRef.number);
    const coderabbitReviews = reviews.filter((r) => r.user.login === GITHUB_CODERABBIT_USERNAME);

    if (coderabbitReviews.length === 0) {
      await this.client.postComment(prRef.owner, prRef.repo, prRef.number, "No CodeRabbit reviews found on this PR.");
      return;
    }

    // Collect all review comments with file/line context
    const { feedback, allComments } = await this.buildReviewFeedback(prRef, coderabbitReviews, "CodeRabbit Review Feedback");
    if (!feedback) {
      await this.client.postComment(prRef.owner, prRef.repo, prRef.number, "No actionable comments found in CodeRabbit reviews.");
      return;
    }

    log.info(`CodeRabbit feedback for ${task.key}: ${coderabbitReviews.length} review(s)`);

    const replyFn = this.createReplyFn(prRef);

    await this.feedbackHandler({
      taskKey: task.key,
      feedback,
      mode: "fix",
      replyFn,
    });

    // Reply to each review comment confirming it was addressed
    await this.replyToReviewComments(prRef, allComments);
  }
}
