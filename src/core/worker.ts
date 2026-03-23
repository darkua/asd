import { logger, createLogger } from "../logger.js";
import type { Notifier } from "../ports/notifier.js";
import type { TaskSource } from "../ports/task-source.js";
import type { FeedbackListener } from "../ports/feedback-listener.js";
import type { Store } from "../ports/store.js";
import type { VCS } from "../ports/vcs.js";
import type { AIProvider } from "../ports/ai-provider.js";
import type { RawFeedback, WorkerConfig, WorkerStatus } from "../ports/types.js";
import { TaskPipeline } from "./task-pipeline.js";

export class Worker {
  private processingLock = new Map<string, Promise<void>>();
  private feedbackQueue: Array<{ taskKey: string; feedback: string; mode: "fix" | "redo"; replyFn: (text: string) => Promise<void> }> = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastCleanupTime = 0;

  constructor(
    private pipeline: TaskPipeline,
    private feedbackListener: FeedbackListener | null,
    private notifier: Notifier,
    private taskSource: TaskSource,
    private store: Store,
    private vcs: VCS,
    private ai: AIProvider,
    private config: WorkerConfig,
  ) {}

  async start(): Promise<void> {
    // Verify prerequisites
    this.vcs.ensureReady();

    // Recover tasks stuck in "processing" from a previous crash
    const stuckTasks = this.store.getTasksByStatus("processing");
    for (const task of stuckTasks) {
      logger.warn(`Recovering stuck task ${task.key} — marking as failed`);
      this.store.markFailed(task.key, "Worker restarted — task was interrupted");

      // Clear stale PID if process is no longer alive
      if (task.childProcessPid) {
        try {
          process.kill(task.childProcessPid, 0); // check if alive
        } catch {
          this.store.clearChildPid(task.key);
        }
      }
    }
    if (stuckTasks.length > 0) {
      logger.info(`Recovered ${stuckTasks.length} stuck task(s)`);
    }

    // Start feedback listener (if configured and not --once mode)
    if (!this.config.isOnce && this.feedbackListener) {
      this.feedbackListener.onFeedback((raw) => this.handleRawFeedback(raw));
      this.feedbackListener.onStatusRequest(() => this.getStatus());
      await this.feedbackListener.start();
    }

    if (this.config.isOnce) {
      logger.info("Running single poll cycle (--once mode)");
      await this.pollCycle();
      logger.info("Done.");
      return;
    }

    // Continuous mode
    await this.notifier.notifyWorkerStart();
    await this.pollCycle();

    this.interval = setInterval(() => this.pollCycle(), this.config.pollIntervalMs);

    // Graceful shutdown
    const shutdown = async () => {
      logger.info("Shutting down...");
      await this.stop();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    logger.info("Polling loop active. Press Ctrl+C to stop.");
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.feedbackListener) {
      await this.feedbackListener.stop();
    }
  }

  private async pollCycle(): Promise<void> {
    logger.info("--- Poll cycle start ---");

    // Periodic cleanup of stale worktrees (once per hour)
    const ONE_HOUR = 60 * 60 * 1000;
    if (Date.now() - this.lastCleanupTime > ONE_HOUR) {
      this.lastCleanupTime = Date.now();
      try {
        this.cleanupStaleWorktrees();
      } catch (err) {
        logger.warn(`Worktree cleanup error: ${err}`);
      }
    }

    try {
      const tasks = await this.taskSource.poll();

      const newTasks = tasks.filter(
        (t) => !this.store.isProcessed(t.key) && !this.vcs.branchExists(t.key),
      );

      if (newTasks.length === 0) {
        logger.info("No new tasks");
        return;
      }

      logger.info(`${newTasks.length} new task(s) to process`);

      const concurrency = this.config.maxConcurrent;

      // Process in batches of maxConcurrent
      for (let i = 0; i < newTasks.length; i += concurrency) {
        const batch = newTasks.slice(i, i + concurrency);

        if (batch.length > 1) {
          logger.info(`Processing batch of ${batch.length} tasks in parallel`);
        }

        await Promise.all(batch.map(async (task) => {
          let lockResolve!: () => void;
          const lockPromise = new Promise<void>((resolve) => { lockResolve = resolve; });
          this.processingLock.set(task.key, lockPromise);

          try {
            await this.pipeline.processTask(task);
          } finally {
            this.processingLock.delete(task.key);
            lockResolve();
            await this.drainFeedbackQueue();
          }
        }));
      }
    } catch (err) {
      logger.error(`Poll cycle error: ${err}`);
    }

    const stats = this.store.getStats();
    logger.info(`Stats: ${stats.review} review, ${stats.done} done, ${stats.failed} failed, ${stats.processing} processing`);
  }

  private async handleRawFeedback(raw: RawFeedback): Promise<void> {
    const log = createLogger(raw.taskKey);
    const key = raw.taskKey;

    const task = this.store.getTask(key);
    if (!task) {
      log.debug(`No tracked task for key ${key}`);
      return;
    }

    log.info(`Feedback received for ${key}: "${raw.feedback.slice(0, 100)}"`);

    // Handle special commands
    const lowerFeedback = raw.feedback.toLowerCase().trim();

    if (lowerFeedback === "cancel" || lowerFeedback === "stop") {
      log.info(`Cancel requested for ${key}`);
      const currentTask = this.store.getTask(key);
      if (currentTask?.childProcessPid) {
        await this.ai.kill(currentTask.childProcessPid);
      }
      this.store.markFailed(key, "Cancelled by user");
      await raw.replyFn("Task cancelled.");
      return;
    }

    if (lowerFeedback === "retry") {
      const currentTask = this.store.getTask(key);
      if (currentTask?.status !== "failed") {
        await raw.replyFn("Only failed tasks can be retried.");
        return;
      }
      log.info(`Retry requested for ${key}`);
      this.store.resetTask(key);
      try { this.vcs.removeWorktree(key); } catch { /* ignore */ }
      try { this.vcs.deleteBranch(key); } catch { /* ignore */ }
      await raw.replyFn("Task reset and branch cleaned up. Will be picked up in the next poll cycle.");
      return;
    }

    if (lowerFeedback === "status") {
      const status = this.getStatus();
      const lines = [
        `*Task ${key}:* ${task.status}`,
        `Feedback rounds: ${task.feedbackRound}`,
        `Processing: ${status.processing.length > 0 ? status.processing.join(", ") : "none"}`,
        `Queue: ${status.queueSize} pending`,
      ];
      await raw.replyFn(lines.join("\n"));
      return;
    }

    if (lowerFeedback === "reopen") {
      if (!task.feedbackClosed) {
        await raw.replyFn("Feedback is already open for this task.");
        return;
      }
      log.info(`Reopen requested for ${key}`);
      this.store.reopenFeedback(key);
      await raw.replyFn("Feedback reopened. Send your feedback.");
      return;
    }

    // Check if feedback is closed
    if (task.feedbackClosed) {
      await raw.replyFn("Feedback for this task has been closed.");
      return;
    }

    // Check 24h auto-decline timeout
    if (task.limitReachedAt) {
      const limitTime = new Date(task.limitReachedAt).getTime();
      const now = Date.now();
      const twentyFourHours = 24 * 60 * 60 * 1000;

      if (now - limitTime > twentyFourHours) {
        this.store.setFeedbackClosed(key);
        await raw.replyFn("No response within 24 hours — work on this task has been closed.");
        return;
      }

      // Awaiting confirmation state
      const lower = raw.feedback.toLowerCase();
      if (lower === "tak" || lower === "yes") {
        this.store.resetFeedbackLimit(key);
        await raw.replyFn("Limit reset. Send your feedback.");
        return;
      } else if (lower === "nie" || lower === "no") {
        this.store.setFeedbackClosed(key);
        await raw.replyFn("Work on this task has been closed.");
        return;
      } else {
        await raw.replyFn(`Please respond with "tak" to continue or "nie" to stop.`);
        return;
      }
    }

    // Check feedback round limit (modular — works after limit reset)
    const currentTask = this.store.getTask(key);
    const currentRound = (currentTask?.feedbackRound || 0) + 1;
    const maxRounds = this.config.maxFeedbackRounds;

    // Limit triggers at multiples of maxRounds (3, 6, 9...)
    if (currentRound > maxRounds && (currentRound - 1) % maxRounds === 0) {
      this.store.setLimitReachedAt(key);
      const totalMaxDisplay = currentRound - 1 + maxRounds;
      await raw.replyFn(
        `Reached limit of ${currentRound - 1} feedback rounds. Reply "tak" to continue for another ${maxRounds} rounds (up to ${totalMaxDisplay}), or "nie" to stop.`,
      );
      return;
    }

    // Parse mode from prefix
    let mode: "fix" | "redo" = raw.mode;
    let feedback = raw.feedback;

    if (!feedback) {
      await raw.replyFn("Empty feedback — please describe what to change.");
      return;
    }

    // Kill active process if running
    if (currentTask?.childProcessPid) {
      await raw.replyFn("Stopping current work to apply your feedback...");
      await this.ai.kill(currentTask.childProcessPid);
    }

    // Increment round
    const round = this.store.incrementFeedbackRound(key);

    await raw.replyFn(
      `Processing feedback (round ${round} of ${maxRounds}, mode: ${mode})...`,
    );

    // Check if another task is being processed — queue if busy
    for (const [lockKey] of this.processingLock) {
      if (lockKey !== key) {
        log.info(`Task ${lockKey} is processing, queuing feedback for ${key}`);
        this.feedbackQueue.push({ taskKey: key, feedback, mode, replyFn: raw.replyFn });
        return;
      }
    }

    // Set lock and process
    let lockResolve!: () => void;
    const lockPromise = new Promise<void>((resolve) => { lockResolve = resolve; });
    this.processingLock.set(key, lockPromise);

    try {
      await this.pipeline.handleFeedback(key, feedback, mode);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await raw.replyFn(`Feedback processing failed: ${errorMsg}`);
    } finally {
      this.processingLock.delete(key);
      lockResolve();
      await this.drainFeedbackQueue();
    }
  }

  private cleanupStaleWorktrees(): void {
    const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const status of ["done", "failed"] as const) {
      const tasks = this.store.getTasksByStatus(status);
      for (const task of tasks) {
        if (!task.completedAt) continue;
        const completedTime = new Date(task.completedAt).getTime();
        if (now - completedTime < SEVEN_DAYS) continue;

        try {
          this.vcs.removeWorktree(task.key);
          logger.debug(`Cleaned up stale worktree for ${task.key}`);
        } catch {
          // Already cleaned or doesn't exist
        }
      }
    }
  }

  private getStatus(): WorkerStatus {
    return {
      processing: Array.from(this.processingLock.keys()),
      queueSize: this.feedbackQueue.length,
      stats: this.store.getStats(),
    };
  }

  private async drainFeedbackQueue(): Promise<void> {
    if (this.feedbackQueue.length === 0) return;

    const item = this.feedbackQueue.shift()!;
    const { taskKey, feedback, mode, replyFn } = item;

    logger.info(`Draining queued feedback for ${taskKey}`);

    let lockResolve!: () => void;
    const lockPromise = new Promise<void>((resolve) => { lockResolve = resolve; });
    this.processingLock.set(taskKey, lockPromise);

    try {
      await this.pipeline.handleFeedback(taskKey, feedback, mode);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await replyFn(`Feedback processing failed: ${errorMsg}`);
    } finally {
      this.processingLock.delete(taskKey);
      lockResolve();
      await this.drainFeedbackQueue();
    }
  }
}
