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
