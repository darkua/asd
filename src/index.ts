import { config } from "./config.js";
import { logger, createLogger } from "./logger.js";
import { pollForTasks, transitionToInProgress, transitionToInReview, addComment } from "./jira.js";
import type { TaskInfo } from "./jira.js";
import { runClaudeCode, runClaudeCodeWithFeedback } from "./claude.js";
import { ensureRepoReady, branchExists, createWorktree, removeWorktree, worktreePath, branchName } from "./git.js";
import { isProcessed, markProcessing, markDone, markFailed, getStats, setSlackThread, getTask, markReprocessing, setTaskInfo } from "./store.js";
import { notifyWorkerStart, notifyTaskStarted, notifyTaskStatus, notifyTaskCompleted, notifyTaskFailed } from "./slack.js";
import * as slackBot from "./slack-bot.js";
import type { FeedbackRequest } from "./slack-bot.js";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

// ─── Feedback Infrastructure ────────────────────────────────

const processingLock = new Map<string, Promise<void>>();
const feedbackQueue = new Map<string, { feedback: string; mode: "fix" | "redo" }>();

// ─── Single Task Pipeline ─────────────────────────────────────

async function processTask(task: TaskInfo): Promise<void> {
  const log = createLogger(task.key);
  let workDir: string | null = null;
  let slackChannel: string | undefined;
  let slackThreadTs: string | undefined;

  try {
    // ── Guard: already processed? ──
    if (isProcessed(task.key)) {
      log.debug("Already processed, skipping");
      return;
    }

    // ── Guard: branch already exists (from manual work or failed cleanup)? ──
    if (branchExists(task.key)) {
      log.warn("Branch already exists — skipping to avoid conflict");
      return;
    }

    log.info(`▶ Starting: ${task.summary}`);
    markProcessing(task.key);
    setTaskInfo(task.key, task);
    processingLock.set(task.key, Promise.resolve());

    // ── Step 1: Post Slack thread (before any work) ──
    const threadInfo = await notifyTaskStarted(task);
    if (threadInfo) {
      slackChannel = threadInfo.channel;
      slackThreadTs = threadInfo.ts;
      setSlackThread(task.key, threadInfo.ts, threadInfo.channel);
    }

    // ── Step 2: Update JIRA status ──
    await transitionToInProgress(task.key);

    // ── Step 3: Create isolated worktree ──
    workDir = createWorktree(task.key);
    await notifyTaskStatus(slackChannel, slackThreadTs, "🔀 Worktree created, starting Claude Code...");

    // ── Step 4: Run Claude Code CLI ──
    await notifyTaskStatus(slackChannel, slackThreadTs, "🤖 Claude is implementing the task...");
    const result = await runClaudeCode(task, workDir);

    // ── Step 5: Handle result ──
    if (result.success && result.prUrl) {
      log.info(`✅ PR created: ${result.prUrl}`);

      // Update JIRA
      await transitionToInReview(task.key);
      await addComment(
        task.key,
        `🤖 AI implementation complete.\nPR: ${result.prUrl}\nDuration: ${(result.durationMs / 1000).toFixed(0)}s\n\n⚠️ Requires human review before merge.`
      );

      // Track & notify
      markDone(task.key, result.prUrl);
      const completedThread = await notifyTaskCompleted(task, result, slackChannel, slackThreadTs);
      if (completedThread && !slackThreadTs) {
        setSlackThread(task.key, completedThread.ts, completedThread.channel);
      }
    } else {
      const errorMsg = result.prUrl
        ? `Claude finished but no PR was created (exit code: ${result.exitCode})`
        : `Claude Code failed (exit code: ${result.exitCode}): ${result.result.slice(0, 300)}`;

      log.error(`❌ ${errorMsg}`);
      markFailed(task.key, errorMsg);

      await addComment(task.key, `🤖 AI implementation failed: ${errorMsg.slice(0, 500)}`);
      const failThread = await notifyTaskFailed(task, errorMsg, slackChannel, slackThreadTs);
      if (failThread && !slackThreadTs) {
        setSlackThread(task.key, failThread.ts, failThread.channel);
      }
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.error(`💥 Unhandled error: ${errorMsg}`);
    markFailed(task.key, errorMsg);
    const errThread = await notifyTaskFailed(task, errorMsg, slackChannel, slackThreadTs);
    if (errThread && !slackThreadTs) {
      setSlackThread(task.key, errThread.ts, errThread.channel);
    }
  } finally {
    // Worktree is kept after task completion for inspection
    if (workDir) {
      log.info(`Worktree kept at: ${workDir}`);
    }
    processingLock.delete(task.key);
    await drainFeedbackQueue();
  }
}

// ─── Feedback Queue ─────────────────────────────────────────

async function drainFeedbackQueue(): Promise<void> {
  if (feedbackQueue.size === 0) return;

  const entry = feedbackQueue.entries().next();
  if (entry.done) return;

  const [jiraKey, { feedback, mode }] = entry.value;
  feedbackQueue.delete(jiraKey);

  logger.info(`Draining queued feedback for ${jiraKey}`);
  await handleFeedback({ jiraKey, feedback, mode });
}

// ─── Feedback Processing ────────────────────────────────────

async function handleFeedback(request: FeedbackRequest): Promise<void> {
  const { jiraKey, feedback, mode } = request;
  const log = createLogger(jiraKey);

  // Check if another task is being processed
  for (const [key] of processingLock) {
    if (key !== jiraKey) {
      log.info(`Task ${key} is processing, queuing feedback for ${jiraKey}`);
      feedbackQueue.set(jiraKey, { feedback, mode });
      return;
    }
  }

  // Set lock BEFORE starting async work to prevent race conditions
  let lockResolve: () => void;
  const lockPromise = new Promise<void>((resolve) => { lockResolve = resolve; });
  processingLock.set(jiraKey, lockPromise);

  try {
    const taskData = getTask(jiraKey);
    if (!taskData) {
      log.error("Task not found in store");
      return;
    }

    // Use stored TaskInfo (saved during initial processTask) for accurate prompt
    const taskInfo: TaskInfo = taskData.taskInfo || {
      key: jiraKey,
      summary: jiraKey,
      description: "",
      issueType: "Task",
      priority: "Medium",
      url: `${config.jira.baseUrl}/browse/${jiraKey}`,
    };

    try {
      // markReprocessing preserves existing fields (slackThreadTs, feedbackRound, taskInfo, etc.)
      markReprocessing(jiraKey);
      await transitionToInProgress(jiraKey);

      let workDir: string;
      const existingWorktreePath = worktreePath(jiraKey);

      if (mode === "redo") {
        // Close existing PR
        try {
          execSync(
            `gh pr close ${branchName(jiraKey)} --delete-branch`,
            { cwd: config.repo.path, encoding: "utf-8", stdio: "pipe" },
          );
        } catch {
          log.debug("No existing PR to close or gh CLI unavailable");
        }

        removeWorktree(jiraKey);
        workDir = createWorktree(jiraKey);
      } else {
        // fix mode — use existing worktree or fallback to redo
        if (existsSync(existingWorktreePath)) {
          workDir = existingWorktreePath;
        } else {
          log.warn("Worktree not found, falling back to redo mode");
          if (taskData.slackThreadTs && taskData.slackChannel) {
            await slackBot.replyInThread(
              taskData.slackChannel,
              taskData.slackThreadTs,
              "Worktree not found — creating fresh (redo mode).",
            );
          }
          workDir = createWorktree(jiraKey);
        }
      }

      const round = taskData.feedbackRound || 1;
      const maxRounds = config.worker.maxFeedbackRounds;

      const result = await runClaudeCodeWithFeedback(
        taskInfo, workDir, feedback, mode, round, maxRounds,
      );

      if (result.success && result.prUrl) {
        log.info(`Feedback applied, PR: ${result.prUrl}`);
        await transitionToInReview(jiraKey);
        await addComment(
          jiraKey,
          `AI feedback applied (round ${round}).\nPR: ${result.prUrl}\nDuration: ${(result.durationMs / 1000).toFixed(0)}s`,
        );
        markDone(jiraKey, result.prUrl);

        if (taskData.slackThreadTs && taskData.slackChannel) {
          await slackBot.replyInThread(
            taskData.slackChannel,
            taskData.slackThreadTs,
            `Feedback applied (round ${round}). PR: ${result.prUrl}`,
          );
        }
      } else {
        const errorMsg = `Feedback round ${round} failed (exit ${result.exitCode}): ${result.result.slice(0, 300)}`;
        log.error(errorMsg);
        markFailed(jiraKey, errorMsg);
        await addComment(jiraKey, `AI feedback round ${round} failed: ${errorMsg.slice(0, 500)}`);

        if (taskData.slackThreadTs && taskData.slackChannel) {
          await slackBot.replyInThread(
            taskData.slackChannel,
            taskData.slackThreadTs,
            `Feedback round ${round} failed: ${errorMsg.slice(0, 200)}`,
          );
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error(`Feedback error: ${errorMsg}`);
      markFailed(jiraKey, errorMsg);
    }
  } finally {
    processingLock.delete(jiraKey);
    lockResolve!();
    await drainFeedbackQueue();
  }
}

// ─── Polling Cycle ─────────────────────────────────────────────

async function pollCycle(): Promise<void> {
  logger.info("─── Poll cycle start ───");

  try {
    const tasks = await pollForTasks();

    const newTasks = tasks.filter(
      (t) => !isProcessed(t.key) && !branchExists(t.key)
    );

    if (newTasks.length === 0) {
      logger.info("No new tasks");
      return;
    }

    logger.info(`${newTasks.length} new task(s) to process`);

    // Process sequentially (MAX subscription has rate limits)
    for (const task of newTasks) {
      await processTask(task);
    }
  } catch (err) {
    logger.error(`Poll cycle error: ${err}`);
  }

  const stats = getStats();
  logger.info(`Stats: ${stats.done} done, ${stats.failed} failed, ${stats.processing} processing`);
}

// ─── Entry Point ───────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info("╔══════════════════════════════════════╗");
  logger.info("║   JIRA AI Worker · Claude Code MAX   ║");
  logger.info("╚══════════════════════════════════════╝");
  logger.info(`Project: ${config.jira.project}`);
  logger.info(`Trigger: label "${config.jira.triggerLabel}"`);
  logger.info(`Repo: ${config.repo.path}`);
  logger.info(`Poll interval: ${config.worker.pollIntervalMs / 60000} min`);
  logger.info(`Max turns: ${config.worker.maxTurns}`);

  // Verify prerequisites
  ensureRepoReady();

  // Check Claude Code is installed
  try {
    const { execSync } = await import("node:child_process");
    const version = execSync("claude --version", { encoding: "utf-8" }).trim();
    logger.info(`Claude Code: ${version}`);
  } catch {
    throw new Error(
      "Claude Code CLI not found. Install with: npm install -g @anthropic-ai/claude-code"
    );
  }

  // Check gh CLI for PR creation
  try {
    const { execSync } = await import("node:child_process");
    execSync("gh auth status", { encoding: "utf-8", stdio: "pipe" });
    logger.info("GitHub CLI: authenticated");
  } catch {
    logger.warn(
      "GitHub CLI (gh) not authenticated. Claude will use git + API fallback for PR creation."
    );
  }

  const isOnce = process.argv.includes("--once");

  // Start Slack Bot (if configured and not --once mode)
  if (!isOnce && config.slack.botToken && config.slack.appToken) {
    slackBot.setFeedbackHandler(handleFeedback);
    await slackBot.start();
  }

  if (isOnce) {
    logger.info("Running single poll cycle (--once mode)");
    await pollCycle();
    logger.info("Done.");
    return;
  }

  // Continuous mode
  await notifyWorkerStart();
  await pollCycle(); // Run immediately on start

  const interval = setInterval(pollCycle, config.worker.pollIntervalMs);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    clearInterval(interval);
    await slackBot.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  logger.info(`Polling loop active. Press Ctrl+C to stop.`);
}

main().catch((err) => {
  logger.error(`Fatal: ${err}`);
  process.exit(1);
});
