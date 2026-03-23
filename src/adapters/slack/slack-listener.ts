import type { FeedbackListener, RawFeedbackHandler } from "../../ports/feedback-listener.js";
import type { Store } from "../../ports/store.js";
import { SlackClient } from "./slack-client.js";
import { createLogger } from "../../logger.js";

const log = createLogger();

export class SlackListener implements FeedbackListener {
  private readonly client: SlackClient;
  private readonly store: Store;
  private feedbackHandler: RawFeedbackHandler | null = null;

  constructor(client: SlackClient, store: Store) {
    this.client = client;
    this.store = store;
  }

  onFeedback(handler: RawFeedbackHandler): void {
    this.feedbackHandler = handler;
  }

  async start(): Promise<void> {
    this.client.onMessage((message) => this.handleMessage(message));
  }

  async stop(): Promise<void> {
    // No-op — SlackClient handles Bolt shutdown
  }

  private async handleMessage(message: any): Promise<void> {
    // Filter: bot messages and subtypes (edits, joins, etc.)
    if (message.bot_id || message.subtype) return;

    // Filter: only thread replies (thread_ts must exist and differ from ts)
    if (!message.thread_ts || message.thread_ts === message.ts) return;

    const text: string = message.text?.trim() || "";

    // Filter: empty text
    if (!text) return;

    log.debug(`Slack message received in thread ${message.thread_ts}: "${text.slice(0, 100)}"`);

    // Lookup task by thread
    const task = this.store.getTaskByThread(message.thread_ts);
    if (!task) {
      log.debug(`No tracked task for thread ${message.thread_ts}`);
      return;
    }

    log.info(`Feedback received for ${task.key}: "${text.slice(0, 100)}"`);

    const channel = message.channel as string;
    const threadTs = message.thread_ts as string;

    const replyFn = async (replyText: string): Promise<void> => {
      await this.client.replyInThread(channel, threadTs, replyText);
    };

    // Parse mode from prefix
    let mode: "fix" | "redo" = "fix";
    let feedback = text;

    if (text.toLowerCase().startsWith("redo:")) {
      mode = "redo";
      feedback = text.slice(5).trim();
    } else if (text.toLowerCase().startsWith("fix:")) {
      feedback = text.slice(4).trim();
    }

    // Filter: empty feedback after prefix strip
    if (!feedback) {
      await replyFn("Empty feedback — please describe what to change.");
      return;
    }

    if (!this.feedbackHandler) return;

    try {
      await this.feedbackHandler({
        taskKey: task.key,
        feedback,
        mode,
        replyFn,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await replyFn(`Feedback processing failed: ${errorMsg}`);
    }
  }
}
