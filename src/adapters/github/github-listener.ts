import type { FeedbackListener, RawFeedbackHandler, StatusHandler } from "../../ports/feedback-listener.js";
import type { TaskQueryStore } from "../../ports/store.js";
import type { StoredTask } from "../../ports/types.js";
import { GitHubClient } from "./github-client.js";
import { GitHubWebhookHandler, type WebhookEventHandler } from "./github-webhook-handler.js";
import type { GitHubWebhookPayload, PrRef } from "./github-types.js";
import { createLogger } from "../../logger.js";
import { toErrorMessage } from "../../utils/errors.js";
import {
  GITHUB_CODERABBIT_DEBOUNCE_MS,
  CANCEL_COMMANDS,
} from "../../constants.js";

const log = createLogger();

export interface GitHubListenerConfig {
  botUsername: string;
  reviewBotUsers: string[];
  webhookSecret: string;
}

interface DebouncedReview {
  taskKey: string;
  prRef: PrRef;
  comments: string[];
  timer: ReturnType<typeof setTimeout>;
}

export class GitHubListener implements FeedbackListener {
  private feedbackHandler: RawFeedbackHandler | null = null;
  private statusHandler: StatusHandler | null = null;
  private readonly webhookHandler: GitHubWebhookHandler;
  private readonly debouncedReviews = new Map<string, DebouncedReview>();
  private authenticatedUser = "";

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

  async start(): Promise<void> {
    this.authenticatedUser = await this.client.resolveAuthenticatedUser();
    log.info("GitHub listener ready (webhook-based)");
  }

  async stop(): Promise<void> {
    // Clear all debounce timers
    for (const review of this.debouncedReviews.values()) {
      clearTimeout(review.timer);
    }
    this.debouncedReviews.clear();
  }

  // ─── Event Routing ───────────────────────────────────────

  private handleEvent(eventType: string, payload: GitHubWebhookPayload): void {
    if (eventType !== "issue_comment" && eventType !== "pull_request_review_comment") {
      log.debug(`Ignoring GitHub event: ${eventType}`);
      return;
    }

    if (payload.action !== "created") {
      log.debug(`Ignoring GitHub comment action: ${payload.action}`);
      return;
    }

    // Process asynchronously — webhook already returned 200
    this.processComment(eventType, payload).catch((err) => {
      log.warn(`Error processing GitHub comment: ${toErrorMessage(err)}`);
    });
  }

  private async processComment(eventType: string, payload: GitHubWebhookPayload): Promise<void> {
    const comment = payload.comment;
    const author = comment.user.login;

    // Self-loop prevention
    if (this.authenticatedUser && author === this.authenticatedUser) return;
    if (this.config.botUsername && author === this.config.botUsername) return;

    // Resolve PR reference
    const prRef = this.extractPrRef(eventType, payload);
    if (!prRef) {
      log.debug("Could not extract PR reference from GitHub webhook — ignoring");
      return;
    }

    // Find matching task by PR URL
    const prUrl = `https://github.com/${prRef.owner}/${prRef.repo}/pull/${prRef.number}`;
    const task = this.findTaskByPrUrl(prUrl);
    if (!task) {
      log.debug(`No tracked task for PR ${prUrl}`);
      return;
    }

    const isReviewBot = this.config.reviewBotUsers.includes(author);
    const isMention = this.config.botUsername
      ? comment.body.includes(`@${this.config.botUsername}`)
      : false;

    if (!isReviewBot && !isMention) {
      log.debug(`GitHub comment by ${author} is not a mention or review bot — ignoring`);
      return;
    }

    log.info(`GitHub ${isReviewBot ? "review bot" : "mention"} comment on ${task.key} by ${author}`);

    if (isReviewBot) {
      this.handleReviewBotComment(task.key, prRef, comment.body);
      return;
    }

    // Human @mention — parse command/feedback
    const text = this.stripMention(comment.body);
    const { feedback, mode, isCommand } = this.parseComment(text);

    if (isCommand && feedback === "status") {
      await this.handleStatusCommand(prRef, task);
      return;
    }

    if (!this.feedbackHandler) {
      log.warn("GitHub listener has no feedback handler registered");
      return;
    }

    const replyFn = async (replyText: string): Promise<void> => {
      await this.client.postComment(prRef.owner, prRef.repo, prRef.number, replyText);
    };

    await this.feedbackHandler({
      taskKey: task.key,
      feedback,
      mode,
      replyFn,
    });
  }

  // ─── CodeRabbit Debounce ─────────────────────────────────

  private handleReviewBotComment(taskKey: string, prRef: PrRef, body: string): void {
    const debounceKey = `${prRef.owner}/${prRef.repo}#${prRef.number}`;
    const existing = this.debouncedReviews.get(debounceKey);

    const scheduleFlush = (): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        this.flushReviewComments(debounceKey).catch((err) => {
          log.warn(`Failed to flush review comments for ${debounceKey}: ${toErrorMessage(err)}`);
        });
      }, GITHUB_CODERABBIT_DEBOUNCE_MS);

    if (existing) {
      clearTimeout(existing.timer);
      existing.comments.push(body);
      existing.timer = scheduleFlush();
    } else {
      const timer = scheduleFlush();
      this.debouncedReviews.set(debounceKey, {
        taskKey,
        prRef,
        comments: [body],
        timer,
      });
    }
  }

  private async flushReviewComments(debounceKey: string): Promise<void> {
    const review = this.debouncedReviews.get(debounceKey);
    if (!review) return;
    this.debouncedReviews.delete(debounceKey);

    if (!this.feedbackHandler) return;

    const combinedFeedback = review.comments.join("\n\n---\n\n");
    log.info(`Flushing ${review.comments.length} review bot comment(s) for ${review.taskKey}`);

    const replyFn = async (text: string): Promise<void> => {
      await this.client.postComment(review.prRef.owner, review.prRef.repo, review.prRef.number, text);
    };

    await this.feedbackHandler({
      taskKey: review.taskKey,
      feedback: combinedFeedback,
      mode: "fix",
      replyFn,
    });
  }

  // ─── Helpers ─────────────────────────────────────────────

  private extractPrRef(eventType: string, payload: GitHubWebhookPayload): PrRef | null {
    const repo = payload.repository;

    if (eventType === "pull_request_review_comment" && payload.pull_request) {
      return { owner: repo.owner.login, repo: repo.name, number: payload.pull_request.number };
    }

    if (eventType === "issue_comment" && payload.issue?.pull_request) {
      // issue_comment on a PR — extract number from issue
      return { owner: repo.owner.login, repo: repo.name, number: payload.issue.number };
    }

    return null;
  }

  private findTaskByPrUrl(prUrl: string): StoredTask | undefined {
    const normalized = prUrl.replace(/\/$/, "");
    for (const status of ["review", "processing"] as const) {
      const tasks = this.store.getTasksByStatus(status);
      const match = tasks.find((t) => t.prUrl?.replace(/\/$/, "") === normalized);
      if (match) return match;
    }
    return undefined;
  }

  private stripMention(text: string): string {
    if (!this.config.botUsername) return text.trim();
    return text.replace(new RegExp(`@${this.config.botUsername}\\s*`, "gi"), "").trim();
  }

  private parseComment(text: string): { feedback: string; mode: "fix" | "redo"; isCommand: boolean } {
    const lower = text.toLowerCase().trim();

    // Commands — reuse constants from FeedbackCommandHandler
    const commands: readonly string[] = [
      ...CANCEL_COMMANDS, "retry", "status",
    ];
    if (commands.includes(lower)) {
      return { feedback: lower, mode: "fix", isCommand: lower === "status" };
    }

    // Explicit mode prefix
    if (lower.startsWith("fix:")) {
      return { feedback: text.slice(4).trim(), mode: "fix", isCommand: false };
    }
    if (lower.startsWith("redo:")) {
      return { feedback: text.slice(5).trim(), mode: "redo", isCommand: false };
    }

    // Default: bare text = fix mode
    return { feedback: text, mode: "fix", isCommand: false };
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
}
