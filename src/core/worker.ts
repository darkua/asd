import { createLogger, logger } from "../logger.js";
import type { Notifier } from "../ports/notifier.js";
import type { TaskSource } from "../ports/task-source.js";
import type { FeedbackListener, TaskRunRequest } from "../ports/feedback-listener.js";
import type { Store } from "../ports/store.js";
import type { VCS } from "../ports/vcs.js";
import type { AIProvider } from "../ports/ai-provider.js";
import type { RawFeedback, TaskInfo, WorkerConfig, WorkerStatus } from "../ports/types.js";
import { TaskPipeline } from "./task-pipeline.js";
import { FeedbackCommandHandler } from "./feedback-command-handler.js";
import { ProcessingLockManager } from "./processing-lock-manager.js";
import { ONE_HOUR_MS, SEVEN_DAYS_MS } from "../constants.js";
import { toErrorMessage } from "../utils/errors.js";

export class Worker {
  private readonly lockManager = new ProcessingLockManager();
  private readonly commandHandler: FeedbackCommandHandler;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastCleanupTime = 0;

  constructor(
    private pipeline: TaskPipeline,
    private feedbackListener: FeedbackListener | null,
    private notifier: Notifier,
    private taskSource: TaskSource,
    private store: Store,
    private vcs: VCS,
    ai: AIProvider,
    private config: WorkerConfig,
  ) {
    this.commandHandler = new FeedbackCommandHandler({
      store,
      vcs,
      ai,
      getStatus: () => this.getStatus(),
    });
  }

  async start(): Promise<void> {
    this.vcs.ensureReady();
    this.recoverStuckTasks();

    // Start feedback listener (if configured and not --once mode)
    if (!this.config.isOnce && this.feedbackListener) {
      this.feedbackListener.onFeedback((raw) => this.handleRawFeedback(raw));
      this.feedbackListener.onStatusRequest(() => this.getStatus());
      this.feedbackListener.onTaskRunRequest(async (req) => {
        void this.handleTaskRunRequest(req).catch(async (e) => {
          try {
            await req.replyFn(`Error: ${toErrorMessage(e)}`);
          } catch {
            /* ignore */
          }
        });
      });
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

  // ─── Private ──────────────────────────────────────────────

  private recoverStuckTasks(): void {
    const stuckTasks = this.store.getTasksByStatus("processing");
    for (const task of stuckTasks) {
      logger.warn(`Recovering stuck task ${task.key} — marking as failed`);
      this.store.markFailed(task.key, "Worker restarted — task was interrupted");

      if (task.childProcessPid) {
        try {
          process.kill(task.childProcessPid, 0);
        } catch {
          this.store.clearChildPid(task.key);
        }
      }
    }
    if (stuckTasks.length > 0) {
      logger.info(`Recovered ${stuckTasks.length} stuck task(s)`);
    }
  }

  private async pollCycle(): Promise<void> {
    logger.info("--- Poll cycle start ---");

    if (Date.now() - this.lastCleanupTime > ONE_HOUR_MS) {
      this.lastCleanupTime = Date.now();
      try {
        this.cleanupStaleWorktrees();
      } catch (err) {
        logger.warn(`Worktree cleanup error: ${toErrorMessage(err)}`);
      }
    }

    try {
      const tasks = await this.taskSource.poll();
      const newTasks = tasks.filter(
        (t) => !this.store.isProcessed(t.key) && !this.vcs.branchExists(t.key),
      );

      if (newTasks.length === 0) {
        if (tasks.length > 0) {
          for (const t of tasks) {
            if (this.store.isProcessed(t.key)) {
              const st = this.store.getTask(t.key)?.status;
              logger.info(
                `Skipping ${t.key}: already tracked in worker state (status=${st}; clear state or use reset if you meant to rerun)`,
              );
            } else if (this.vcs.branchExists(t.key)) {
              logger.info(
                `Skipping ${t.key}: git branch for this ticket already exists — delete local/remote feat/${t.key.toLowerCase()} (and worktree under .worktrees/) to pick it up again`,
              );
            }
          }
        }
        logger.info("No new tasks");
        return;
      }

      logger.info(`${newTasks.length} new task(s) to process`);
      const concurrency = this.config.maxConcurrent;

      for (let i = 0; i < newTasks.length; i += concurrency) {
        const batch = newTasks.slice(i, i + concurrency);
        if (batch.length > 1) {
          logger.info(`Processing batch of ${batch.length} tasks in parallel`);
        }

        await Promise.all(batch.map(async (task) => {
          await this.lockManager.withLock(task.key, async () => {
            await this.pipeline.processTask(task);
          });
          await this.lockManager.drainQueue(this.pipeline);
        }));
      }
    } catch (err) {
      logger.error(`Poll cycle error: ${toErrorMessage(err)}`);
    }

    const stats = this.store.getStats();
    logger.info(`Stats: ${stats.review} review, ${stats.done} done, ${stats.failed} failed, ${stats.processing} processing`);
  }

  /**
   * Slack: pasted JIRA browse URL or bare ticket key — fetch issue, cleanup if failed/orphan branch, run pipeline.
   */
  private async handleTaskRunRequest(req: TaskRunRequest): Promise<void> {
    const { issueKey, replyFn, bypassJiraStatusCheck, directAgentPrompt } = req;
    const log = createLogger(issueKey);
    log.info(
      bypassJiraStatusCheck
        ? "Manual task run requested (Slack retry — JIRA status checks bypassed)"
        : "Manual task run requested (JIRA link or key from Slack)",
    );

    const manualOpts = bypassJiraStatusCheck ? { bypassStatusFilter: true } : undefined;
    const fetched = await this.taskSource.fetchIssueForManualRun(issueKey, manualOpts);
    if (!fetched.ok) {
      await replyFn(fetched.reason);
      return;
    }

    const { task, jiraStatusName } = fetched;
    const stored = this.store.getTask(issueKey);

    if (stored?.status === "processing") {
      await replyFn(
        `*${issueKey}* is already **processing** in the worker (AI run in flight).`,
      );
      return;
    }
    if (stored?.status === "review") {
      await replyFn(
        stored.prUrl
          ? `*${issueKey}* already has a PR: ${stored.prUrl}`
          : `*${issueKey}* is in review in worker state but has no PR URL stored.`,
      );
      return;
    }
    if (stored?.status === "done") {
      await replyFn(`*${issueKey}* is already marked done in worker state.`);
      return;
    }

    if (this.lockManager.isLocked(issueKey)) {
      await replyFn(`*${issueKey}* is already running (lock held). Try again shortly.`);
      return;
    }

    const jiraSt = jiraStatusName.toLowerCase();
    if (!bypassJiraStatusCheck && jiraSt === "in progress") {
      const recovering =
        stored?.status === "failed" ||
        this.vcs.branchExists(issueKey);
      if (!recovering) {
        await replyFn(
          `⚠️ *${issueKey}* is already **In progress** in JIRA — the worker will not start another implementation run (it may already be in progress there or assigned to someone else). ` +
            `If the last *worker* run failed, use \`retry ${issueKey}\` or paste the link again after failure so cleanup can run. ` +
            `To run again from scratch, move the issue to **To Do** in JIRA first.`,
        );
        return;
      }
    }

    await replyFn(`*${issueKey}* — preparing (clearing failed state / git branch if needed)…`);

    if (stored?.status === "failed" || this.vcs.branchExists(issueKey)) {
      this.store.resetTask(issueKey);
      try {
        this.vcs.removeWorktree(issueKey);
      } catch {
        /* ignore */
      }
      try {
        this.vcs.deleteBranch(issueKey);
      } catch {
        /* ignore */
      }
      log.info(`Manual run: cleaned worker state / git for ${issueKey}`);
    }

    if (this.store.isProcessed(issueKey)) {
      const st = this.store.getTask(issueKey)?.status ?? "?";
      await replyFn(`*${issueKey}* is still tracked (${st}) — cannot start a fresh run.`);
      return;
    }

    if (this.vcs.branchExists(issueKey)) {
      await replyFn(
        `*${issueKey}*: feature branch still exists after cleanup. Remove \`feat/${issueKey.toLowerCase()}\` (local + remote) and try again.`,
      );
      return;
    }

    const direct = directAgentPrompt?.trim();
    if (direct) {
      await replyFn(`Starting AI for *${issueKey}* with **operator-directed** prompt…`);
    } else {
      await replyFn(`Starting AI implementation for *${issueKey}*…`);
    }

    const taskToRun: TaskInfo = direct ? { ...task, directPromptOverride: direct } : task;

    await this.lockManager.withLock(issueKey, async () => {
      await this.pipeline.processTask(taskToRun);
    });
    await this.lockManager.drainQueue(this.pipeline);
  }

  private async handleRawFeedback(raw: RawFeedback): Promise<void> {
    const result = await this.commandHandler.handle(raw);
    if (result.handled) return;

    const { feedback, mode } = result;
    if (!feedback || !mode) return;

    // Queue if another task is processing
    if (this.lockManager.hasOtherLock(raw.taskKey)) {
      logger.info(`Another task is processing, queuing feedback for ${raw.taskKey}`);
      this.lockManager.enqueue({ taskKey: raw.taskKey, feedback, mode, replyFn: raw.replyFn, onCompleteFn: raw.onCompleteFn });
      return;
    }

    let success = false;
    await this.lockManager.withLock(raw.taskKey, async () => {
      try {
        await this.pipeline.handleFeedback(raw.taskKey, feedback, mode);
        success = true;
      } catch (err) {
        await raw.replyFn(`Feedback processing failed: ${toErrorMessage(err)}`);
      }
    });

    if (raw.onCompleteFn) {
      await raw.onCompleteFn(success).catch((err) => {
        logger.warn(`onCompleteFn error for ${raw.taskKey}: ${toErrorMessage(err)}`);
      });
    }

    await this.lockManager.drainQueue(this.pipeline);
  }

  private cleanupStaleWorktrees(): void {
    const now = Date.now();
    for (const status of ["done", "failed"] as const) {
      const tasks = this.store.getTasksByStatus(status);
      for (const task of tasks) {
        if (!task.completedAt) continue;
        const completedTime = new Date(task.completedAt).getTime();
        if (now - completedTime < SEVEN_DAYS_MS) continue;

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
      processing: this.lockManager.activeKeys,
      queueSize: this.lockManager.queueSize,
      stats: this.store.getStats(),
    };
  }
}
