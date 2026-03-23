# Slack Thread-Based Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace post-completion Slack notifications with thread-based lifecycle updates — each task gets a dedicated thread at start with status updates throughout processing.

**Architecture:** Extend `slack-bot.ts` with `updateMessage()`. Add new thread-aware notification functions in `slack.ts` alongside existing webhook functions. Modify `processTask()` in `index.ts` to post thread messages at key stages.

**Tech Stack:** TypeScript, @slack/bolt (chat.update API), existing project patterns

**Spec:** `docs/superpowers/specs/2026-03-23-slack-thread-notifications-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/slack-bot.ts` | Modify | Add `updateMessage()` function |
| `src/slack.ts` | Modify | Add `notifyTaskStarted`, `notifyTaskStatus`, `notifyTaskCompleted`, `notifyTaskFailed` |
| `src/index.ts` | Modify | Rewire `processTask()` to use new thread-based notifications |

---

### Task 1: Add `updateMessage` to `slack-bot.ts`

**Files:**
- Modify: `src/slack-bot.ts`

- [ ] **Step 1: Add `updateMessage` function after the existing `replyInThread` function (after line 108)**

```typescript
export async function updateMessage(
  channel: string,
  ts: string,
  blocks: SlackBlock[],
  text?: string,
): Promise<void> {
  if (!app) return;

  try {
    await app.client.chat.update({
      channel,
      ts,
      blocks: blocks as any,
      text: text || "",
    });
  } catch (err) {
    log.warn(`Failed to update Slack message: ${err}`);
  }
}
```

- [ ] **Step 2: Verify build**

Run: `cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/slack-bot.ts
git commit -m "feat(slack): add updateMessage to slack-bot for editing posted messages"
```

---

### Task 2: Add thread-based notification functions to `slack.ts`

**Files:**
- Modify: `src/slack.ts`

- [ ] **Step 1: Add `notifyTaskStarted` function after `notifyWorkerStart` (after line 112)**

This function posts the main message on the channel and immediately posts the JIRA link in the thread. Returns thread info or undefined.

```typescript
export async function notifyTaskStarted(
  task: TaskInfo,
): Promise<{ ts: string; channel: string } | void> {
  if (!slackBot.isActive() || !config.slack.channel) return;

  try {
    const mainBlocks: SlackBlock[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*🔧 ${task.key}: ${task.summary}*\nPriority: ${task.priority} · Type: ${task.issueType}`,
        },
      },
    ];

    const threadInfo = await slackBot.postMessage(config.slack.channel, mainBlocks);

    // Post JIRA link in thread immediately
    await slackBot.replyInThread(
      threadInfo.channel,
      threadInfo.ts,
      `📋 JIRA: <${task.url}|${task.key}>`,
    );

    return threadInfo;
  } catch (err) {
    log.warn(`Slack Bolt notification failed, falling back to webhook mode: ${err}`);
    return undefined;
  }
}
```

- [ ] **Step 2: Add `notifyTaskStatus` function**

```typescript
export async function notifyTaskStatus(
  channel: string | undefined,
  threadTs: string | undefined,
  text: string,
): Promise<void> {
  if (!channel || !threadTs || !slackBot.isActive()) return;

  try {
    await slackBot.replyInThread(channel, threadTs, text);
  } catch (err) {
    log.warn(`Slack thread status update failed: ${err}`);
  }
}
```

- [ ] **Step 3: Add `notifyTaskCompleted` function**

```typescript
export async function notifyTaskCompleted(
  task: TaskInfo,
  result: ClaudeResult,
  channel: string | undefined,
  threadTs: string | undefined,
): Promise<{ ts: string; channel: string } | void> {
  // Bolt thread mode
  if (channel && threadTs && slackBot.isActive()) {
    try {
      // Post success in thread
      await slackBot.replyInThread(
        channel,
        threadTs,
        `✅ PR created: <${result.prUrl}|View Pull Request>\nDuration: ${(result.durationMs / 1000).toFixed(0)}s`,
      );

      // Update main message
      await slackBot.updateMessage(channel, threadTs, [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*✅ ${task.key}: ${task.summary} — Done*\nPriority: ${task.priority} · Type: ${task.issueType}`,
          },
        },
      ], `${task.key}: ${task.summary} — Done`);

      return { ts: threadTs, channel };
    } catch (err) {
      log.warn(`Slack Bolt completion notification failed, falling back to webhook: ${err}`);
    }
  }

  // Webhook fallback
  return notifySuccess(task, result);
}
```

- [ ] **Step 4: Add `notifyTaskFailed` function**

```typescript
export async function notifyTaskFailed(
  task: TaskInfo,
  error: string,
  channel: string | undefined,
  threadTs: string | undefined,
): Promise<{ ts: string; channel: string } | void> {
  // Bolt thread mode
  if (channel && threadTs && slackBot.isActive()) {
    try {
      // Post failure in thread
      await slackBot.replyInThread(
        channel,
        threadTs,
        `❌ Implementation failed:\n\`\`\`${error.slice(0, 500)}\`\`\``,
      );

      // Update main message
      await slackBot.updateMessage(channel, threadTs, [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*❌ ${task.key}: ${task.summary} — Failed*\nPriority: ${task.priority} · Type: ${task.issueType}`,
          },
        },
      ], `${task.key}: ${task.summary} — Failed`);

      return { ts: threadTs, channel };
    } catch (err) {
      log.warn(`Slack Bolt failure notification failed, falling back to webhook: ${err}`);
    }
  }

  // Webhook fallback
  return notifyFailure(task, error);
}
```

- [ ] **Step 5: Verify build**

Run: `cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/slack.ts
git commit -m "feat(slack): add thread-based notification functions for task lifecycle"
```

---

### Task 3: Rewire `processTask()` in `index.ts`

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update imports**

Add new imports from `slack.ts`. Change line 8 from:

```typescript
import { notifySuccess, notifyFailure, notifyWorkerStart } from "./slack.js";
```

to:

```typescript
import { notifyWorkerStart, notifyTaskStarted, notifyTaskStatus, notifyTaskCompleted, notifyTaskFailed } from "./slack.js";
```

- [ ] **Step 2: Rewrite `processTask()` — replace the body from line 21 to line 99**

Replace the full function with this updated version that posts the thread early and sends status updates at each stage:

```typescript
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
```

- [ ] **Step 3: Verify build**

Run: `cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Manual smoke test**

Run: `cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npm run worker:once`

Verify in logs:
- Worker polls JIRA for tasks
- If a task is found with Bolt mode configured, Slack channel should get a main message + JIRA link in thread
- Status updates appear in the thread
- On completion, main message updates emoji

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(slack): rewire processTask to use thread-based notifications"
```

---

### Task 4: Verify `handleFeedback` still works with threads

**Files:**
- Read: `src/index.ts` (handleFeedback function)

- [ ] **Step 1: Verify no changes needed**

Read through `handleFeedback()` in `index.ts`. It already uses `taskData.slackThreadTs` and `taskData.slackChannel` from the store, and calls `slackBot.replyInThread()` directly. Since the thread is now created earlier (in `processTask` step 1), the `slackThreadTs` is available from the start — feedback replies will land in the correct thread.

No code changes needed. Confirm by reading the function.

- [ ] **Step 2: Commit (no-op — confirmation only)**

No commit needed. This task is a verification step.
