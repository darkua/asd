import { existsSync } from "node:fs";
import { createLogger } from "../logger.js";
import type { AIProvider } from "../ports/ai-provider.js";
import type { TaskSource } from "../ports/task-source.js";
import type { Notifier } from "../ports/notifier.js";
import type { Store } from "../ports/store.js";
import type { VCS } from "../ports/vcs.js";
import type { TaskInfo, ThreadRef, ProgressEvent } from "../ports/types.js";

export class TaskPipeline {
  constructor(
    private ai: AIProvider,
    private taskSource: TaskSource,
    private notifier: Notifier,
    private store: Store,
    private vcs: VCS,
  ) {}

  async processTask(task: TaskInfo): Promise<void> {
    const log = createLogger(task.key);
    let workDir: string | null = null;
    let thread: ThreadRef | undefined;

    try {
      // Guard: already processed?
      if (this.store.isProcessed(task.key)) {
        log.debug("Already processed, skipping");
        return;
      }

      // Guard: branch already exists?
      if (this.vcs.branchExists(task.key)) {
        log.warn("Branch already exists — skipping to avoid conflict");
        return;
      }

      log.info(`Starting: ${task.summary}`);
      this.store.markProcessing(task.key);
      this.store.setTaskInfo(task.key, task);

      // Step 1: Notify task started
      const threadRef = await this.notifier.notifyTaskStarted(task);
      if (threadRef) {
        thread = threadRef;
        this.store.setThreadRef(task.key, threadRef);
      }

      // Step 2: Update task source status
      await this.taskSource.transitionToInProgress(task.key);

      // Step 3: Create isolated worktree
      workDir = this.vcs.createWorktree(task.key);
      if (thread) {
        await this.notifier.notifyTaskStatus(thread, "Worktree created, starting AI...");
      }

      // Step 4: Run AI
      if (thread) {
        await this.notifier.notifyTaskStatus(thread, "AI is implementing the task...");
      }

      // Create throttled progress notifier
      let lastProgressTime = 0;
      const progressCallback = thread ? (event: ProgressEvent) => {
        const now = Date.now();
        if (now - lastProgressTime < 60_000) return; // throttle: max 1 per 60s
        lastProgressTime = now;

        const elapsed = Math.round(event.elapsedMs / 1000);
        const msg = `Turn ${event.turn}/${event.maxTurns} (${elapsed}s) — ${event.type === "tool_use" ? event.detail : event.type}`;
        this.notifier.notifyTaskStatus(thread!, msg).catch(() => {});
      } : undefined;

      const result = await this.ai.run(task, workDir, progressCallback);
      if (result.costUsd != null) {
        this.store.setCost(task.key, result.costUsd);
      }

      // Step 5: Handle result
      if (result.success && result.prUrl) {
        // Validate PR actually exists
        const prValid = await this.vcs.validatePrUrl(result.prUrl);
        if (!prValid) {
          const errorMsg = `AI claimed PR at ${result.prUrl} but it does not exist`;
          log.error(errorMsg);
          this.store.markFailed(task.key, errorMsg);
          await this.taskSource.addComment(task.key, `AI implementation failed: ${errorMsg}`);
          const failThread = await this.notifier.notifyTaskFailed(task, errorMsg, thread);
          if (failThread && !thread) this.store.setThreadRef(task.key, failThread);
          return;
        }

        log.info(`PR created: ${result.prUrl}`);

        await this.taskSource.transitionToReview(task.key);
        await this.taskSource.addComment(
          task.key,
          `AI implementation complete.\nPR: ${result.prUrl}\nDuration: ${(result.durationMs / 1000).toFixed(0)}s\n\nRequires human review before merge.`,
        );

        this.store.markDone(task.key, result.prUrl);
        const completedThread = await this.notifier.notifyTaskCompleted(task, result, thread);
        if (completedThread && !thread) {
          this.store.setThreadRef(task.key, completedThread);
        }
      } else {
        const errorMsg = result.prUrl
          ? `AI finished but no PR was created (exit code: ${result.exitCode})`
          : `AI failed (exit code: ${result.exitCode}): ${result.result.slice(0, 300)}`;

        log.error(errorMsg);
        this.store.markFailed(task.key, errorMsg);

        await this.taskSource.addComment(task.key, `AI implementation failed: ${errorMsg.slice(0, 500)}`);
        const failThread = await this.notifier.notifyTaskFailed(task, errorMsg, thread);
        if (failThread && !thread) {
          this.store.setThreadRef(task.key, failThread);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Unhandled error: ${errorMsg}`);
      this.store.markFailed(task.key, errorMsg);
      const errThread = await this.notifier.notifyTaskFailed(task, errorMsg, thread);
      if (errThread && !thread) {
        this.store.setThreadRef(task.key, errThread);
      }
    } finally {
      if (workDir) {
        createLogger(task.key).info(`Worktree kept at: ${workDir}`);
      }
    }
  }

  async handleFeedback(key: string, feedback: string, mode: "fix" | "redo"): Promise<void> {
    const log = createLogger(key);

    const taskData = this.store.getTask(key);
    if (!taskData) {
      log.error("Task not found in store");
      return;
    }

    // Use stored TaskInfo or fallback
    const taskInfo: TaskInfo = taskData.taskInfo || {
      key,
      summary: key,
      description: "",
      issueType: "Task",
      priority: "Medium",
      url: "",
    };

    const thread = taskData.threadRef;

    try {
      // markReprocessing preserves existing fields
      this.store.markReprocessing(key);
      await this.taskSource.transitionToInProgress(key);

      let workDir: string;
      const existingWorktreePath = this.vcs.worktreePath(key);

      if (mode === "redo") {
        this.vcs.closePR(key);
        this.vcs.removeWorktree(key);
        workDir = this.vcs.createWorktree(key);
      } else {
        // fix mode — use existing worktree or fallback
        if (existsSync(existingWorktreePath)) {
          workDir = existingWorktreePath;
        } else {
          log.warn("Worktree not found, falling back to redo mode");
          if (thread) {
            await this.notifier.replyInThread(thread, "Worktree not found — creating fresh (redo mode).");
          }
          workDir = this.vcs.createWorktree(key);
        }
      }

      const round = taskData.feedbackRound || 1;
      const maxRounds = 3;

      // Create throttled progress notifier for feedback run
      let lastFeedbackProgressTime = 0;
      const feedbackProgressCallback = thread ? (event: ProgressEvent) => {
        const now = Date.now();
        if (now - lastFeedbackProgressTime < 60_000) return; // throttle: max 1 per 60s
        lastFeedbackProgressTime = now;

        const elapsed = Math.round(event.elapsedMs / 1000);
        const msg = `Turn ${event.turn}/${event.maxTurns} (${elapsed}s) — ${event.type === "tool_use" ? event.detail : event.type}`;
        this.notifier.notifyTaskStatus(thread!, msg).catch(() => {});
      } : undefined;

      const result = await this.ai.runWithFeedback(taskInfo, workDir, {
        feedback,
        mode,
        round,
        maxRounds,
      }, feedbackProgressCallback);

      if (result.success && result.prUrl) {
        // Validate PR actually exists
        const prValid = await this.vcs.validatePrUrl(result.prUrl);
        if (!prValid) {
          const errorMsg = `AI claimed PR at ${result.prUrl} but it does not exist`;
          log.error(errorMsg);
          this.store.markFailed(key, errorMsg);
          await this.taskSource.addComment(key, `AI implementation failed: ${errorMsg}`);
          if (thread) {
            await this.notifier.replyInThread(thread, `Feedback processing error: ${errorMsg}`);
          }
          return;
        }

        log.info(`Feedback applied, PR: ${result.prUrl}`);
        await this.taskSource.transitionToReview(key);
        await this.taskSource.addComment(
          key,
          `AI feedback applied (round ${round}).\nPR: ${result.prUrl}\nDuration: ${(result.durationMs / 1000).toFixed(0)}s`,
        );
        this.store.markDone(key, result.prUrl);

        if (thread) {
          await this.notifier.replyInThread(thread, `Feedback applied (round ${round}). PR: ${result.prUrl}`);
        }
      } else {
        const errorMsg = `Feedback round ${round} failed (exit ${result.exitCode}): ${result.result.slice(0, 300)}`;
        log.error(errorMsg);
        this.store.markFailed(key, errorMsg);
        await this.taskSource.addComment(key, `AI feedback round ${round} failed: ${errorMsg.slice(0, 500)}`);

        if (thread) {
          await this.notifier.replyInThread(thread, `Feedback round ${round} failed: ${errorMsg.slice(0, 200)}`);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Feedback error: ${errorMsg}`);
      this.store.markFailed(key, errorMsg);

      if (thread) {
        await this.notifier.replyInThread(thread, `Feedback processing error: ${errorMsg.slice(0, 300)}`);
      }
    }
  }

  killProcess(pid: number): Promise<void> {
    return this.ai.kill(pid);
  }
}
