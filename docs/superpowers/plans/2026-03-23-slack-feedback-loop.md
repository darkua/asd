# Slack Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable bidirectional Slack communication so users can reply in task notification threads to provide feedback, triggering the AI agent to fix or redo its work.

**Architecture:** Slack Bolt SDK in Socket Mode runs alongside the existing polling loop. When a user replies in a notification thread, the worker maps `thread_ts` to a JIRA key, optionally kills an active Claude Code process, and re-runs Claude with the feedback. Backward compatible — without bot tokens, the worker operates as before (webhook only).

**Tech Stack:** `@slack/bolt` (Socket Mode), Node.js `child_process` (detached process groups), existing store (JSON file persistence)

**Spec:** `docs/superpowers/specs/2026-03-23-slack-feedback-loop-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/config.ts` | Modify | Add new env vars: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_CHANNEL`, `MAX_FEEDBACK_ROUNDS` |
| `src/store.ts` | Modify | Add new fields to `ProcessedTask`: `slackThreadTs`, `slackChannel`, `feedbackRound`, `feedbackClosed`, `childProcessPid`, `limitReachedAt`, `taskInfo`. Add helpers: `setSlackThread()`, `incrementFeedbackRound()`, `setChildPid()`, `clearChildPid()`, `getTaskByThreadTs()`, `markReprocessing()`, `setTaskInfo()` |
| `src/claude.ts` | Modify | Add `detached: true` to spawn, save/clear PID in store, export `killClaudeProcess()`, add `runClaudeCodeWithFeedback()` |
| `src/slack-bot.ts` | Create | Slack Bolt App init, Socket Mode, message handler, `postMessage()`, `replyInThread()`, `isActive()`, `stop()` |
| `src/slack.ts` | Modify | Delegate to `slack-bot.ts` when bot is active, return `{ts, channel}` from notifications |
| `src/index.ts` | Modify | Start Slack bot, `processTaskWithFeedback()`, feedback queue, processing lock, updated shutdown |

---

### Task 1: Install dependency and update config

**Files:**
- Modify: `package.json`
- Modify: `src/config.ts:15-52`

- [ ] **Step 1: Install @slack/bolt**

```bash
cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npm install @slack/bolt
```

- [ ] **Step 2: Add new env vars to config.ts**

In `src/config.ts`, add to the `slack` section after `channel`:

```ts
  slack: {
    webhookUrl: optional("SLACK_WEBHOOK_URL", ""),
    channel: optional("SLACK_CHANNEL", ""),
    botToken: optional("SLACK_BOT_TOKEN", ""),
    appToken: optional("SLACK_APP_TOKEN", ""),
  },
```

Add to the `worker` section after `timeoutMs`:

```ts
    maxFeedbackRounds: parseInt(optional("MAX_FEEDBACK_ROUNDS", "3")),
```

- [ ] **Step 3: Verify it compiles**

```bash
cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json src/config.ts
git commit -m "feat: add @slack/bolt dependency and new config vars for feedback loop"
```

---

### Task 2: Extend store with new fields and helpers

**Files:**
- Modify: `src/store.ts:1-86`

- [ ] **Step 1: Add new fields to ProcessedTask interface**

In `src/store.ts`, update the `ProcessedTask` interface:

```ts
interface StoredTaskInfo {
  key: string;
  summary: string;
  description: string;
  issueType: string;
  priority: string;
  url: string;
}

interface ProcessedTask {
  jiraKey: string;
  startedAt: string;
  completedAt?: string;
  status: "processing" | "done" | "failed";
  prUrl?: string;
  error?: string;
  slackThreadTs?: string;
  slackChannel?: string;
  feedbackRound: number;
  feedbackClosed?: boolean;
  childProcessPid?: number;
  limitReachedAt?: string;
  taskInfo?: StoredTaskInfo;
}
```

- [ ] **Step 2: Add helper functions**

Append these functions to `src/store.ts`:

```ts
export function setSlackThread(jiraKey: string, threadTs: string, channel: string): void {
  const state = loadState();
  if (state.processed[jiraKey]) {
    state.processed[jiraKey].slackThreadTs = threadTs;
    state.processed[jiraKey].slackChannel = channel;
    saveState(state);
  }
}

export function getTaskByThreadTs(threadTs: string): ProcessedTask | undefined {
  const state = loadState();
  return Object.values(state.processed).find((t) => t.slackThreadTs === threadTs);
}

export function incrementFeedbackRound(jiraKey: string): number {
  const state = loadState();
  const task = state.processed[jiraKey];
  if (!task) return 0;
  task.feedbackRound = (task.feedbackRound || 0) + 1;
  saveState(state);
  return task.feedbackRound;
}

export function setChildPid(jiraKey: string, pid: number): void {
  const state = loadState();
  if (state.processed[jiraKey]) {
    state.processed[jiraKey].childProcessPid = pid;
    saveState(state);
  }
}

export function clearChildPid(jiraKey: string): void {
  const state = loadState();
  if (state.processed[jiraKey]) {
    state.processed[jiraKey].childProcessPid = undefined;
    saveState(state);
  }
}

export function setFeedbackClosed(jiraKey: string): void {
  const state = loadState();
  if (state.processed[jiraKey]) {
    state.processed[jiraKey].feedbackClosed = true;
    saveState(state);
  }
}

export function setLimitReachedAt(jiraKey: string): void {
  const state = loadState();
  if (state.processed[jiraKey]) {
    state.processed[jiraKey].limitReachedAt = new Date().toISOString();
    saveState(state);
  }
}

export function resetFeedbackLimit(jiraKey: string): void {
  const state = loadState();
  if (state.processed[jiraKey]) {
    // Only clear limitReachedAt — feedbackRound keeps incrementing for display ("round 4 of 6")
    state.processed[jiraKey].limitReachedAt = undefined;
    saveState(state);
  }
}

export function getTask(jiraKey: string): ProcessedTask | undefined {
  const state = loadState();
  return state.processed[jiraKey];
}

/**
 * Like markProcessing but preserves existing fields (slackThreadTs, feedbackRound, taskInfo, etc.).
 * Used when re-processing a task due to feedback — must not clobber accumulated state.
 */
export function markReprocessing(jiraKey: string): void {
  const state = loadState();
  if (state.processed[jiraKey]) {
    state.processed[jiraKey].status = "processing";
    state.processed[jiraKey].startedAt = new Date().toISOString();
    state.processed[jiraKey].completedAt = undefined;
    state.processed[jiraKey].error = undefined;
    saveState(state);
  }
}

export function setTaskInfo(jiraKey: string, taskInfo: StoredTaskInfo): void {
  const state = loadState();
  if (state.processed[jiraKey]) {
    state.processed[jiraKey].taskInfo = taskInfo;
    saveState(state);
  }
}
```

- [ ] **Step 3: Fix existing markProcessing to init feedbackRound**

Update `markProcessing` to initialize `feedbackRound`:

```ts
export function markProcessing(jiraKey: string): void {
  const state = loadState();
  state.processed[jiraKey] = {
    jiraKey,
    startedAt: new Date().toISOString(),
    status: "processing",
    feedbackRound: 0,
  };
  saveState(state);
}
```

- [ ] **Step 4: Verify it compiles**

```bash
cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/store.ts
git commit -m "feat(store): add slack thread tracking, feedback round, and child PID fields"
```

---

### Task 3: Update claude.ts — detached spawn, PID tracking, kill, feedback prompt

**Files:**
- Modify: `src/claude.ts:1-213`

- [ ] **Step 1: Add store imports at top of claude.ts**

```ts
import { setChildPid, clearChildPid } from "./store.js";
```

- [ ] **Step 2: Update spawn to use detached: true and track PID**

In `runClaudeCode`, update the spawn call and add PID tracking. Replace the spawn options and add PID save right after spawn:

```ts
    const child = spawn("claude", args, {
      cwd: workDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: config.worker.timeoutMs,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: undefined,
      },
    });

    // Track child PID for potential kill from feedback handler
    if (child.pid) {
      setChildPid(task.key, child.pid);
    }
```

Add `clearChildPid` in the `close` handler, before the `resolve`:

```ts
    child.on("close", (code) => {
      clearChildPid(task.key);
      // ... rest of existing close handler
    });
```

Also add `clearChildPid` in the `error` handler:

```ts
    child.on("error", (err) => {
      clearChildPid(task.key);
      // ... rest of existing error handler
    });
```

- [ ] **Step 3: Add killClaudeProcess function**

Append to `src/claude.ts`:

```ts
/**
 * Kill a running Claude Code process for a given task.
 * Uses process group kill (negative PID) since we spawn with detached: true.
 * Returns a promise that resolves when the process is confirmed dead.
 */
export async function killClaudeProcess(pid: number): Promise<void> {
  const log = createLogger();

  try {
    // Check if process is still alive
    process.kill(-pid, 0);
  } catch {
    log.debug(`Process group ${pid} already dead`);
    return;
  }

  log.info(`Killing Claude Code process group ${pid}`);

  // SIGTERM first — give 5s for graceful shutdown
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return; // already dead
  }

  // Wait up to 5 seconds, then SIGKILL
  await new Promise<void>((resolve) => {
    const checkInterval = setInterval(() => {
      try {
        process.kill(-pid, 0); // check if alive
      } catch {
        clearInterval(checkInterval);
        resolve();
      }
    }, 200);

    setTimeout(() => {
      clearInterval(checkInterval);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // already dead
      }
      resolve();
    }, 5000);
  });

  log.info(`Process group ${pid} terminated`);
}
```

- [ ] **Step 4: Add buildFeedbackPrompt function**

Append to `src/claude.ts`:

```ts
/**
 * Build prompt for a feedback round.
 */
function buildFeedbackPrompt(
  task: TaskInfo,
  feedback: string,
  mode: "fix" | "redo",
  round: number,
  maxRounds: number,
): string {
  const originalPrompt = buildPrompt(task);

  const instructions =
    mode === "fix"
      ? [
          "## Instructions",
          "Review the existing implementation on this branch.",
          "Apply the feedback above. Keep existing work and make targeted changes.",
          "Push changes to origin and update the existing PR.",
          "",
          "## Output",
          "After pushing, output EXACTLY this line:",
          "`PR_URL: <the full GitHub PR URL>`",
        ]
      : [
          "## Instructions",
          "Start a fresh implementation from scratch based on the original task and the feedback.",
          `Create a **draft** pull request targeting \`${config.repo.baseBranch}\`.`,
          "",
          "## Output",
          "After completing the PR, output EXACTLY this line:",
          "`PR_URL: <the full GitHub PR URL>`",
        ];

  return [
    originalPrompt,
    "",
    `## Human Feedback (round ${round} of ${maxRounds})`,
    feedback,
    "",
    ...instructions,
  ].join("\n");
}
```

- [ ] **Step 5: Add runClaudeCodeWithFeedback function**

Append to `src/claude.ts`:

```ts
/**
 * Run Claude Code with human feedback context.
 * Reuses the same spawn logic as runClaudeCode but with a feedback-augmented prompt.
 */
export async function runClaudeCodeWithFeedback(
  task: TaskInfo,
  workDir: string,
  feedback: string,
  mode: "fix" | "redo",
  round: number,
  maxRounds: number,
): Promise<ClaudeResult> {
  const log = createLogger(task.key);
  const startTime = Date.now();

  const prompt = buildFeedbackPrompt(task, feedback, mode, round, maxRounds);
  const systemPrompt = [
    "You are an autonomous software engineer applying human feedback to a JIRA task implementation.",
    "Follow AGENT.md rules strictly. Do not skip tests.",
    "Do not ask for clarification — apply the feedback as described.",
    mode === "fix"
      ? "You are working on an existing branch with prior implementation. Review what exists and make targeted changes."
      : "You are starting fresh. The branch is clean.",
    "Push to origin when done. Create or update the PR using the gh CLI.",
  ].join(" ");

  const args = [
    "-p", prompt,
    "--append-system-prompt", systemPrompt,
    "--output-format", "json",
    "--max-turns", String(config.worker.maxTurns),
    "--verbose",
    "--allowedTools",
    [
      "Read", "Write", "Edit", "Glob", "Grep",
      "Bash(git:*)",
      "Bash(gh pr create:*)",
      "Bash(gh pr view:*)",
      "Bash(npm:*)",
      "Bash(npx:*)",
      "Bash(yarn:*)",
      "Bash(pnpm:*)",
      "Bash(cat:*)",
      "Bash(ls:*)",
      "Bash(find:*)",
      "Bash(head:*)",
      "Bash(tail:*)",
      "Bash(wc:*)",
      "Bash(mkdir:*)",
      "Bash(cp:*)",
      "Bash(mv:*)",
    ].join(","),
  ];

  log.info(`Starting Claude Code with feedback (round ${round}, mode: ${mode})`);
  log.info(`Feedback prompt:\n${prompt}`);

  return new Promise<ClaudeResult>((resolve) => {
    const chunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const child = spawn("claude", args, {
      cwd: workDir,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: config.worker.timeoutMs,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: undefined,
      },
    });

    if (child.pid) {
      setChildPid(task.key, child.pid);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      const line = chunk.toString().trim();
      if (line) log.debug(`[stderr] ${line}`);
    });

    child.on("error", (err) => {
      clearChildPid(task.key);
      log.error(`Process error: ${err.message}`);
      resolve({
        success: false,
        result: `Process error: ${err.message}`,
        prUrl: null,
        exitCode: null,
        durationMs: Date.now() - startTime,
        raw: "",
      });
    });

    child.on("close", (code) => {
      clearChildPid(task.key);
      const durationMs = Date.now() - startTime;
      const rawOutput = Buffer.concat(chunks).toString("utf-8");

      log.info(`Claude Code exited with code ${code} in ${(durationMs / 1000).toFixed(1)}s`);

      const parsed = parseClaudeOutput(rawOutput, log);
      const prUrl = extractPrUrl(parsed.result || rawOutput);

      resolve({
        success: code === 0 && prUrl !== null,
        result: parsed.result || rawOutput.slice(-2000),
        prUrl,
        exitCode: code,
        durationMs,
        raw: rawOutput,
      });
    });
  });
}
```

- [ ] **Step 6: Verify it compiles**

```bash
cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/claude.ts
git commit -m "feat(claude): add detached spawn, PID tracking, kill support, and feedback prompt"
```

---

### Task 4: Create slack-bot.ts — Bolt App, Socket Mode, message handler

**Files:**
- Create: `src/slack-bot.ts`

- [ ] **Step 1: Create the slack-bot.ts module**

Create `src/slack-bot.ts` with the full implementation:

```ts
import { App, LogLevel } from "@slack/bolt";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import {
  getTaskByThreadTs,
  getTask,
  incrementFeedbackRound,
  setFeedbackClosed,
  setLimitReachedAt,
  resetFeedbackLimit,
} from "./store.js";
import { killClaudeProcess } from "./claude.js";

const log = createLogger();

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{ type: string; text?: string | { type: string; text: string }; url?: string }>;
  fields?: Array<{ type: string; text: string }>;
}

export interface FeedbackRequest {
  jiraKey: string;
  feedback: string;
  mode: "fix" | "redo";
}

type FeedbackHandler = (request: FeedbackRequest) => Promise<void>;

let app: App | null = null;
let botUserId: string | null = null;
let onFeedbackHandler: FeedbackHandler | null = null;

// ─── Lifecycle ──────────────────────────────────────────────

export function isActive(): boolean {
  return app !== null;
}

export function setFeedbackHandler(handler: FeedbackHandler): void {
  onFeedbackHandler = handler;
}

export async function start(): Promise<void> {
  if (!config.slack.botToken || !config.slack.appToken) {
    log.info("Slack feedback disabled — bot tokens not configured");
    return;
  }

  app = new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  // Get own bot user ID to filter out own messages
  const authResult = await app.client.auth.test();
  botUserId = authResult.user_id || null;
  log.info(`Slack bot connected as user ${botUserId}`);

  // Register message handler
  app.message(async ({ message }) => {
    await handleMessage(message);
  });

  await app.start();
  log.info("Slack Bot started in Socket Mode");
}

export async function stop(): Promise<void> {
  if (app) {
    await app.stop();
    app = null;
    log.info("Slack Bot stopped");
  }
}

// ─── Sending ────────────────────────────────────────────────

export async function postMessage(
  channel: string,
  blocks: SlackBlock[],
): Promise<{ ts: string; channel: string }> {
  if (!app) throw new Error("Slack bot not active");

  const result = await app.client.chat.postMessage({
    channel,
    blocks: blocks as any,
  });

  return { ts: result.ts!, channel: result.channel! };
}

export async function replyInThread(
  channel: string,
  threadTs: string,
  text: string,
): Promise<void> {
  if (!app) return;

  await app.client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text,
  });
}

// ─── Message Handler ────────────────────────────────────────

async function handleMessage(message: any): Promise<void> {
  // Ignore bot messages (own messages, other bots)
  if (message.bot_id || message.subtype) return;

  // Only handle thread replies (must have thread_ts and it must differ from ts)
  if (!message.thread_ts || message.thread_ts === message.ts) return;

  const text: string = message.text?.trim() || "";
  if (!text) return;

  // Find task by thread_ts
  const task = getTaskByThreadTs(message.thread_ts);
  if (!task) return; // Not a tracked thread

  const channel = message.channel as string;
  const threadTs = message.thread_ts as string;

  // Check if feedback is closed for this task
  if (task.feedbackClosed) {
    await replyInThread(channel, threadTs, "Feedback for this task has been closed.");
    return;
  }

  // Check 24h auto-decline timeout
  if (task.limitReachedAt) {
    const limitTime = new Date(task.limitReachedAt).getTime();
    const now = Date.now();
    const twentyFourHours = 24 * 60 * 60 * 1000;

    if (now - limitTime > twentyFourHours) {
      setFeedbackClosed(task.jiraKey);
      await replyInThread(
        channel,
        threadTs,
        "No response within 24 hours — work on this task has been closed.",
      );
      return;
    }

    // We're in the "awaiting confirmation" state
    const lower = text.toLowerCase();
    if (lower === "tak" || lower === "yes") {
      resetFeedbackLimit(task.jiraKey);
      await replyInThread(channel, threadTs, "Limit reset. Send your feedback.");
      return;
    } else if (lower === "nie" || lower === "no") {
      setFeedbackClosed(task.jiraKey);
      await replyInThread(channel, threadTs, "Work on this task has been closed.");
      return;
    } else {
      await replyInThread(
        channel,
        threadTs,
        `Please respond with "tak" to continue or "nie" to stop.`,
      );
      return;
    }
  }

  // Check feedback round limit (modular — works after limit reset)
  const currentTask = getTask(task.jiraKey);
  const currentRound = (currentTask?.feedbackRound || 0) + 1;
  const maxRounds = config.worker.maxFeedbackRounds;

  // Limit triggers at multiples of maxRounds (3, 6, 9...)
  if (currentRound > maxRounds && (currentRound - 1) % maxRounds === 0) {
    setLimitReachedAt(task.jiraKey);
    const totalMaxDisplay = currentRound - 1 + maxRounds;
    await replyInThread(
      channel,
      threadTs,
      `Reached limit of ${currentRound - 1} feedback rounds. Reply "tak" to continue for another ${maxRounds} rounds (up to ${totalMaxDisplay}), or "nie" to stop.`,
    );
    return;
  }

  // Parse mode from prefix
  let mode: "fix" | "redo" = "fix";
  let feedback = text;

  if (text.toLowerCase().startsWith("redo:")) {
    mode = "redo";
    feedback = text.slice(5).trim();
  } else if (text.toLowerCase().startsWith("fix:")) {
    feedback = text.slice(4).trim();
  }

  if (!feedback) {
    await replyInThread(channel, threadTs, "Empty feedback — please describe what to change.");
    return;
  }

  // Kill active Claude process if running
  if (currentTask?.childProcessPid) {
    await replyInThread(channel, threadTs, "Stopping current work to apply your feedback...");
    await killClaudeProcess(currentTask.childProcessPid);
  }

  // Increment round
  const round = incrementFeedbackRound(task.jiraKey);

  await replyInThread(
    channel,
    threadTs,
    `Processing feedback (round ${round} of ${maxRounds}, mode: ${mode})...`,
  );

  // Dispatch to feedback handler
  if (onFeedbackHandler) {
    try {
      await onFeedbackHandler({ jiraKey: task.jiraKey, feedback, mode });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await replyInThread(channel, threadTs, `Feedback processing failed: ${errorMsg}`);
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/slack-bot.ts
git commit -m "feat: add slack-bot module with Bolt Socket Mode and message handler"
```

---

### Task 5: Update slack.ts — dual mode (webhook / Bot API)

**Files:**
- Modify: `src/slack.ts:1-106`

- [ ] **Step 1: Add slack-bot import and update notifySuccess return type**

Update `src/slack.ts`. Add import at top:

```ts
import * as slackBot from "./slack-bot.js";
```

Update `notifySuccess` to return thread info when using bot:

```ts
export async function notifySuccess(
  task: TaskInfo,
  result: ClaudeResult,
): Promise<{ ts: string; channel: string } | void> {
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*AI implementation complete: <${task.url}|${task.key}>*\n${task.summary}`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*PR:*\n<${result.prUrl}|View Pull Request>` },
        { type: "mrkdwn", text: `*Duration:*\n${(result.durationMs / 1000).toFixed(0)}s` },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Auto-generated by Claude Code. Reply in this thread to provide feedback.`,
        },
      ],
    },
  ];

  if (slackBot.isActive() && config.slack.channel) {
    return slackBot.postMessage(config.slack.channel, blocks);
  }

  if (config.slack.webhookUrl) {
    await sendSlack({ blocks });
  }
}
```

- [ ] **Step 2: Update notifyFailure to return thread info**

```ts
export async function notifyFailure(
  task: TaskInfo,
  error: string,
): Promise<{ ts: string; channel: string } | void> {
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*AI implementation failed: <${task.url}|${task.key}>*\n${task.summary}`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `\`\`\`${error.slice(0, 500)}\`\`\``,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "Manual intervention required. Reply in this thread to provide feedback.",
        },
      ],
    },
  ];

  if (slackBot.isActive() && config.slack.channel) {
    return slackBot.postMessage(config.slack.channel, blocks);
  }

  if (config.slack.webhookUrl) {
    await sendSlack({ blocks });
  }
}
```

- [ ] **Step 3: Update notifyWorkerStart to use bot when active**

```ts
export async function notifyWorkerStart(): Promise<void> {
  const text = `JIRA AI Worker started. Polling every ${config.worker.pollIntervalMs / 60000} min for \`${config.jira.triggerLabel}\` tasks in ${config.jira.project}.`;

  if (slackBot.isActive() && config.slack.channel) {
    await slackBot.postMessage(config.slack.channel, [
      { type: "section", text: { type: "mrkdwn", text } },
    ]);
    return;
  }

  if (config.slack.webhookUrl) {
    await sendSlack({ text });
  }
}
```

- [ ] **Step 4: Verify it compiles**

```bash
cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/slack.ts
git commit -m "feat(slack): dual mode — delegate to Bot API when active, fallback to webhook"
```

---

### Task 6: Update index.ts — bot startup, feedback handler, queue, shutdown

**Files:**
- Modify: `src/index.ts:1-179`

- [ ] **Step 1: Add new imports**

At the top of `src/index.ts`, merge these with existing imports:

```ts
import * as slackBot from "./slack-bot.js";
import type { FeedbackRequest } from "./slack-bot.js";
import { runClaudeCodeWithFeedback } from "./claude.js";
import { setSlackThread, getTask, markReprocessing, setTaskInfo } from "./store.js";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
```

Note: `markProcessing`, `markDone`, `markFailed`, `isProcessed`, `getStats` are already imported. `transitionToInProgress`, `transitionToInReview`, `addComment` are already imported. `createWorktree`, `removeWorktree`, `branchName`, `worktreePath` — add `worktreePath` and `branchName` to the existing git import.

- [ ] **Step 2: Add processing lock and feedback queue after imports**

```ts
// ─── Feedback Infrastructure ────────────────────────────────

const processingLock = new Map<string, Promise<void>>();
const feedbackQueue = new Map<string, { feedback: string; mode: "fix" | "redo" }>();
```

- [ ] **Step 3: Save task info and thread info in processTask**

In `processTask`, right after `markProcessing(task.key)`, add:

```ts
    setTaskInfo(task.key, task);
    processingLock.set(task.key, Promise.resolve()); // mark as processing for feedback handler
```

Then update the success block to save thread info. Replace:

```ts
      markDone(task.key, result.prUrl);
      await notifySuccess(task, result);
```

With:

```ts
      markDone(task.key, result.prUrl);
      const threadInfo = await notifySuccess(task, result);
      if (threadInfo) {
        setSlackThread(task.key, threadInfo.ts, threadInfo.channel);
      }
```

In the failure path inside the `if/else`, replace:

```ts
      await notifyFailure(task, errorMsg);
```

With:

```ts
      const failThreadInfo = await notifyFailure(task, errorMsg);
      if (failThreadInfo) {
        setSlackThread(task.key, failThreadInfo.ts, failThreadInfo.channel);
      }
```

In the `catch` block, replace:

```ts
    await notifyFailure(task, errorMsg);
```

With:

```ts
    const errThreadInfo = await notifyFailure(task, errorMsg);
    if (errThreadInfo) {
      setSlackThread(task.key, errThreadInfo.ts, errThreadInfo.channel);
    }
```

- [ ] **Step 4: Add queue drain to processTask finally block**

Update the `finally` block in `processTask`:

```ts
  } finally {
    if (workDir) {
      log.info(`Worktree kept at: ${workDir}`);
    }
    processingLock.delete(task.key);
    await drainFeedbackQueue();
  }
```

- [ ] **Step 5: Add drainFeedbackQueue function**

Add before the `pollCycle` function:

```ts
async function drainFeedbackQueue(): Promise<void> {
  if (feedbackQueue.size === 0) return;

  const entry = feedbackQueue.entries().next();
  if (entry.done) return;

  const [jiraKey, { feedback, mode }] = entry.value;
  feedbackQueue.delete(jiraKey);

  logger.info(`Draining queued feedback for ${jiraKey}`);
  await handleFeedback({ jiraKey, feedback, mode });
}
```

- [ ] **Step 6: Add handleFeedback function**

Add before the `pollCycle` function:

```ts
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
```

- [ ] **Step 7: Update main() — bot startup and shutdown**

In `main()`, move the `isOnce` check earlier (before Slack bot start). Add bot startup after the `gh auth` check:

```ts
  const isOnce = process.argv.includes("--once");

  // Start Slack Bot (if configured and not --once mode)
  if (!isOnce && config.slack.botToken && config.slack.appToken) {
    slackBot.setFeedbackHandler(handleFeedback);
    await slackBot.start();
  }
```

Update the shutdown handler to also kill running Claude processes:

```ts
  const shutdown = async () => {
    logger.info("Shutting down...");
    clearInterval(interval);

    // Kill any running Claude Code processes
    const state = loadState();
    for (const task of Object.values(state.processed)) {
      if (task.childProcessPid) {
        try {
          process.kill(-task.childProcessPid, "SIGTERM");
        } catch {
          // process already dead or PID stale
        }
      }
    }

    await slackBot.stop();
    process.exit(0);
  };
```

Note: Add `loadState` to the store import (or use the existing import pattern — check what's already imported).

- [ ] **Step 8: Verify it compiles**

```bash
cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add src/index.ts
git commit -m "feat(index): integrate Slack bot, feedback handler, queue, and updated shutdown"
```

---

### Task 7: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add Slack feedback section to README**

After the existing Configuration table, add:

```markdown
### Slack Feedback (Optional)

To enable bidirectional Slack communication (reply in threads to give feedback):

1. Create a Slack App at [api.slack.com/apps](https://api.slack.com/apps)
2. Enable **Socket Mode** and create an App-Level Token with `connections:write` scope
3. Add Bot Token Scopes: `chat:write`, `channels:history`, `groups:history`
4. Subscribe to events: `message.channels`, `message.groups`
5. Install the app to your workspace

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SLACK_BOT_TOKEN` | No | — | Bot User OAuth Token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | No | — | App-Level Token (`xapp-...`) |
| `SLACK_CHANNEL` | No | — | Channel ID for notifications |
| `MAX_FEEDBACK_ROUNDS` | No | `3` | Max feedback rounds before asking to continue |

#### Giving feedback

Reply in the Slack notification thread:
- **Fix mode** (default): `fix: improve email validation` or just `improve email validation`
- **Redo mode**: `redo: start over with a different approach`

After reaching the feedback limit, reply `tak`/`yes` to continue or `nie`/`no` to stop.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add Slack feedback configuration and usage to README"
```

---

### Task 8: End-to-end verification

- [ ] **Step 1: Verify full compilation**

```bash
cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: Build the project**

```bash
cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npm run build
```

Expected: compiles to `dist/` without errors.

- [ ] **Step 3: Verify backward compat (no bot tokens)**

Run with `--once` and without `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` set. The worker should start normally and log "Slack feedback disabled" or proceed without Slack bot errors.

```bash
cd /Users/maciejsiara/Downloads/files/jira-ai-worker && npx tsx src/index.ts --once 2>&1 | head -20
```

Expected: normal startup, no Slack bot errors. Will fail on JIRA connection (expected — no real credentials), but should not fail on Slack bot init.

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix: address compilation or integration issues"
```
