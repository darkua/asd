import { existsSync } from "node:fs";
import { createLogger } from "../logger.js";
import type { AIProvider } from "../ports/ai-provider.js";
import type { TaskSource } from "../ports/task-source.js";
import type { Notifier } from "../ports/notifier.js";
import type { Store } from "../ports/store.js";
import type { VCS } from "../ports/vcs.js";
import type { TaskInfo, AIResult, ThreadRef, ProgressEvent } from "../ports/types.js";
import { PROGRESS_THROTTLE_MS } from "../constants.js";
import { toErrorMessage } from "../utils/errors.js";

interface PipelineConfig {
  maxFeedbackRounds: number;
}

export class TaskPipeline {
  constructor(
    private ai: AIProvider,
    private taskSource: TaskSource,
    private notifier: Notifier,
    private store: Store,
    private vcs: VCS,
    private config: PipelineConfig,
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

      const progressCallback = this.createProgressCallback(thread);
      const result = await this.ai.run(task, workDir, progressCallback);
      if (result.costUsd != null) {
        this.store.setCost(task.key, result.costUsd);
      }

      // Step 5: Handle result
      await this.handleAIResult(result, task.key, task, thread);
    } catch (err) {
      const errorMsg = toErrorMessage(err);
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
      const maxRounds = this.config.maxFeedbackRounds;

      const progressCallback = this.createProgressCallback(thread);
      const result = await this.ai.runWithFeedback(taskInfo, workDir, {
        feedback,
        mode,
        round,
        maxRounds,
      }, progressCallback);

      if (result.costUsd != null) {
        this.store.setCost(key, result.costUsd);
      }

      await this.handleAIResult(result, key, taskInfo, thread, round);
    } catch (err) {
      const errorMsg = toErrorMessage(err);
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

  // ─── Private Helpers ────────────────────────────────────────

  private createProgressCallback(thread: ThreadRef | undefined): ((event: ProgressEvent) => void) | undefined {
    if (!thread) return undefined;

    let lastProgressTime = 0;
    return (event: ProgressEvent) => {
      const now = Date.now();
      if (now - lastProgressTime < PROGRESS_THROTTLE_MS) return;
      lastProgressTime = now;

      const elapsed = Math.round(event.elapsedMs / 1000);
      const msg = `Turn ${event.turn}/${event.maxTurns} (${elapsed}s) — ${event.type === "tool_use" ? event.detail : event.type}`;
      this.notifier.notifyTaskStatus(thread, msg).catch(() => {});
    };
  }

  private async handleAIResult(
    result: AIResult,
    key: string,
    taskInfo: TaskInfo,
    thread: ThreadRef | undefined,
    feedbackRound?: number,
  ): Promise<void> {
    const log = createLogger(key);
    const isFeedback = feedbackRound != null;

    if (result.success && result.prUrl) {
      // Validate PR actually exists
      const prValid = await this.vcs.validatePrUrl(result.prUrl);
      if (!prValid) {
        const errorMsg = `AI claimed PR at ${result.prUrl} but it does not exist`;
        log.error(errorMsg);
        this.store.markFailed(key, errorMsg);
        await this.taskSource.addComment(key, `AI implementation failed: ${errorMsg}`);
        if (thread) {
          if (isFeedback) {
            await this.notifier.replyInThread(thread, `Feedback processing error: ${errorMsg}`);
          } else {
            const failThread = await this.notifier.notifyTaskFailed(taskInfo, errorMsg, thread);
            if (failThread && !thread) this.store.setThreadRef(key, failThread);
          }
        } else {
          const failThread = await this.notifier.notifyTaskFailed(taskInfo, errorMsg, thread);
          if (failThread) this.store.setThreadRef(key, failThread);
        }
        return;
      }

      log.info(`${isFeedback ? "Feedback applied" : "PR created"}: ${result.prUrl}`);

      await this.taskSource.transitionToReview(key);
      const comment = isFeedback
        ? `AI feedback applied (round ${feedbackRound}).\nPR: ${result.prUrl}\nDuration: ${(result.durationMs / 1000).toFixed(0)}s`
        : `AI implementation complete.\nPR: ${result.prUrl}\nDuration: ${(result.durationMs / 1000).toFixed(0)}s\n\nRequires human review before merge.`;
      await this.taskSource.addComment(key, comment);

      this.store.markReview(key, result.prUrl);

      if (isFeedback && thread) {
        await this.notifier.replyInThread(thread, `Feedback applied (round ${feedbackRound}). PR: ${result.prUrl}`);
      } else {
        const completedThread = await this.notifier.notifyTaskCompleted(taskInfo, result, thread);
        if (completedThread && !thread) {
          this.store.setThreadRef(key, completedThread);
        }
      }
    } else {
      const errorMsg = isFeedback
        ? `Feedback round ${feedbackRound} failed (exit ${result.exitCode}): ${result.result.slice(0, 300)}`
        : result.prUrl
          ? `AI finished but no PR was created (exit code: ${result.exitCode})`
          : `AI failed (exit code: ${result.exitCode}): ${result.result.slice(0, 300)}`;

      log.error(errorMsg);
      this.store.markFailed(key, errorMsg);
      await this.taskSource.addComment(key, `AI ${isFeedback ? `feedback round ${feedbackRound}` : "implementation"} failed: ${errorMsg.slice(0, 500)}`);

      if (isFeedback && thread) {
        await this.notifier.replyInThread(thread, `Feedback round ${feedbackRound} failed: ${errorMsg.slice(0, 200)}`);
      } else {
        const failThread = await this.notifier.notifyTaskFailed(taskInfo, errorMsg, thread);
        if (failThread && !thread) {
          this.store.setThreadRef(key, failThread);
        }
      }
    }
  }
}
