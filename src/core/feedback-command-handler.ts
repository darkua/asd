import { createLogger } from "../logger.js";
import type { Store } from "../ports/store.js";
import type { VCS } from "../ports/vcs.js";
import type { AIProvider } from "../ports/ai-provider.js";
import type { RawFeedback, StoredTask, WorkerStatus } from "../ports/types.js";
import {
  TWENTY_FOUR_HOURS_MS,
  CANCEL_COMMANDS,
  CONFIRM_YES_COMMANDS,
  CONFIRM_NO_COMMANDS,
} from "../constants.js";

export interface FeedbackCommandResult {
  handled: boolean;
  feedback?: string;
  mode?: "fix" | "redo";
}

interface FeedbackCommandDeps {
  store: Store;
  vcs: VCS;
  ai: AIProvider;
  maxFeedbackRounds: number;
  getStatus: () => WorkerStatus;
}

/**
 * Handles special commands and feedback state machine (round limits, confirmations).
 * Returns whether the command was fully handled (no further processing needed).
 */
export class FeedbackCommandHandler {
  constructor(private deps: FeedbackCommandDeps) {}

  async handle(raw: RawFeedback): Promise<FeedbackCommandResult> {
    const log = createLogger(raw.taskKey);
    const key = raw.taskKey;
    const { store, vcs, ai } = this.deps;

    const task = store.getTask(key);
    if (!task) {
      log.debug(`No tracked task for key ${key}`);
      return { handled: true };
    }

    log.info(`Feedback received for ${key}: "${raw.feedback.slice(0, 100)}"`);
    const lowerFeedback = raw.feedback.toLowerCase().trim();

    // ─── Commands ────────────────────────────────────────────
    if ((CANCEL_COMMANDS as readonly string[]).includes(lowerFeedback)) {
      return this.handleCancel(key, raw.replyFn, log);
    }

    if (lowerFeedback === "retry") {
      return this.handleRetry(key, raw.replyFn, log);
    }

    if (lowerFeedback === "status") {
      return this.handleStatus(key, task, raw.replyFn);
    }

    if (lowerFeedback === "reopen") {
      return this.handleReopen(key, task, raw.replyFn, log);
    }

    // ─── State Guards ────────────────────────────────────────
    if (task.feedbackClosed) {
      await raw.replyFn("Feedback for this task has been closed.");
      return { handled: true };
    }

    if (task.limitReachedAt) {
      return this.handleLimitConfirmation(key, task, raw);
    }

    // ─── Round Limit Check ───────────────────────────────────
    const currentRound = (task.feedbackRound || 0) + 1;
    const maxRounds = this.deps.maxFeedbackRounds;

    if (currentRound > maxRounds && (currentRound - 1) % maxRounds === 0) {
      store.setLimitReachedAt(key);
      const totalMaxDisplay = currentRound - 1 + maxRounds;
      await raw.replyFn(
        `Reached limit of ${currentRound - 1} feedback rounds. Reply "tak" to continue for another ${maxRounds} rounds (up to ${totalMaxDisplay}), or "nie" to stop.`,
      );
      return { handled: true };
    }

    // ─── Validate & Prepare ──────────────────────────────────
    if (!raw.feedback) {
      await raw.replyFn("Empty feedback — please describe what to change.");
      return { handled: true };
    }

    // Kill active process if running
    const currentTask = store.getTask(key);
    if (currentTask?.childProcessPid) {
      await raw.replyFn("Stopping current work to apply your feedback...");
      await ai.kill(currentTask.childProcessPid);
    }

    // Increment round
    const round = store.incrementFeedbackRound(key);
    await raw.replyFn(`Processing feedback (round ${round} of ${maxRounds}, mode: ${raw.mode})...`);

    return { handled: false, feedback: raw.feedback, mode: raw.mode };
  }

  // ─── Private Command Handlers ─────────────────────────────

  private async handleCancel(
    key: string,
    replyFn: (text: string) => Promise<void>,
    log: ReturnType<typeof createLogger>,
  ): Promise<FeedbackCommandResult> {
    log.info(`Cancel requested for ${key}`);
    const task = this.deps.store.getTask(key);
    if (task?.childProcessPid) {
      await this.deps.ai.kill(task.childProcessPid);
    }
    this.deps.store.markFailed(key, "Cancelled by user");
    await replyFn("Task cancelled.");
    return { handled: true };
  }

  private async handleRetry(
    key: string,
    replyFn: (text: string) => Promise<void>,
    log: ReturnType<typeof createLogger>,
  ): Promise<FeedbackCommandResult> {
    const task = this.deps.store.getTask(key);
    if (task?.status !== "failed") {
      await replyFn("Only failed tasks can be retried.");
      return { handled: true };
    }
    log.info(`Retry requested for ${key}`);
    this.deps.store.resetTask(key);
    try { this.deps.vcs.removeWorktree(key); } catch { /* ignore */ }
    try { this.deps.vcs.deleteBranch(key); } catch { /* ignore */ }
    await replyFn("Task reset and branch cleaned up. Will be picked up in the next poll cycle.");
    return { handled: true };
  }

  private async handleStatus(
    key: string,
    task: StoredTask,
    replyFn: (text: string) => Promise<void>,
  ): Promise<FeedbackCommandResult> {
    const status = this.deps.getStatus();
    const lines = [
      `*Task ${key}:* ${task.status}`,
      `Feedback rounds: ${task.feedbackRound}`,
      `Processing: ${status.processing.length > 0 ? status.processing.join(", ") : "none"}`,
      `Queue: ${status.queueSize} pending`,
    ];
    await replyFn(lines.join("\n"));
    return { handled: true };
  }

  private async handleReopen(
    key: string,
    task: StoredTask,
    replyFn: (text: string) => Promise<void>,
    log: ReturnType<typeof createLogger>,
  ): Promise<FeedbackCommandResult> {
    if (!task.feedbackClosed) {
      await replyFn("Feedback is already open for this task.");
      return { handled: true };
    }
    log.info(`Reopen requested for ${key}`);
    this.deps.store.reopenFeedback(key);
    await replyFn("Feedback reopened. Send your feedback.");
    return { handled: true };
  }

  private async handleLimitConfirmation(
    key: string,
    task: StoredTask,
    raw: RawFeedback,
  ): Promise<FeedbackCommandResult> {
    const limitTime = new Date(task.limitReachedAt!).getTime();

    if (Date.now() - limitTime > TWENTY_FOUR_HOURS_MS) {
      this.deps.store.setFeedbackClosed(key);
      await raw.replyFn("No response within 24 hours — work on this task has been closed.");
      return { handled: true };
    }

    const lower = raw.feedback.toLowerCase();
    if ((CONFIRM_YES_COMMANDS as readonly string[]).includes(lower)) {
      this.deps.store.resetFeedbackLimit(key);
      await raw.replyFn("Limit reset. Send your feedback.");
      return { handled: true };
    }
    if ((CONFIRM_NO_COMMANDS as readonly string[]).includes(lower)) {
      this.deps.store.setFeedbackClosed(key);
      await raw.replyFn("Work on this task has been closed.");
      return { handled: true };
    }

    await raw.replyFn(`Please respond with "tak" to continue or "nie" to stop.`);
    return { handled: true };
  }
}
