import type { FeedbackListener, RawFeedbackHandler, StatusHandler } from "../../ports/feedback-listener.js";
import type { Store } from "../../ports/store.js";
import { SlackClient } from "./slack-client.js";
import { createLogger } from "../../logger.js";

const log = createLogger();

export class SlackListener implements FeedbackListener {
  private readonly client: SlackClient;
  private readonly store: Store;
  private feedbackHandler: RawFeedbackHandler | null = null;
  private statusHandler: StatusHandler | null = null;

  constructor(client: SlackClient, store: Store) {
    this.client = client;
    this.store = store;
  }

  onFeedback(handler: RawFeedbackHandler): void {
    this.feedbackHandler = handler;
  }

  onStatusRequest(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  async start(): Promise<void> {
    this.client.onMessage((message) => this.handleMessage(message));
    this.registerActions();
  }

  async stop(): Promise<void> {
    // No-op — SlackClient handles Bolt shutdown
  }

  private registerActions(): void {
    // Direct action buttons (no modal needed)
    for (const cmd of ["task_cancel", "task_retry", "task_status"] as const) {
      this.client.onAction(cmd, async ({ body }) => {
        const action = (body as any).actions?.[0];
        const taskKey = action?.value;
        if (!taskKey || !this.feedbackHandler) return;

        const channel = (body as any).channel?.id;
        const threadTs = (body as any).message?.thread_ts || (body as any).message?.ts;
        const commandMap = { task_cancel: "cancel", task_retry: "retry", task_status: "status" } as const;
        const feedback = commandMap[cmd];

        const replyFn = async (text: string) => {
          if (channel && threadTs) await this.client.replyInThread(channel, threadTs, text);
        };

        await this.feedbackHandler({ taskKey, feedback, mode: "fix", replyFn });
      });
    }

    // Fix/Redo buttons — open modal for user to type feedback
    for (const mode of ["fix", "redo"] as const) {
      this.client.onAction(`task_${mode}`, async ({ body }) => {
        const action = (body as any).actions?.[0];
        const taskKey = action?.value;
        const triggerId = (body as any).trigger_id;
        if (!taskKey || !triggerId) return;

        const threadTs = (body as any).message?.thread_ts || (body as any).message?.ts;
        const channel = (body as any).channel?.id;

        await this.client.openModal(triggerId, {
          type: "modal",
          callback_id: `feedback_${mode}`,
          private_metadata: JSON.stringify({ taskKey, channel, threadTs }),
          title: { type: "plain_text", text: mode === "fix" ? "Fix Implementation" : "Redo Implementation" },
          submit: { type: "plain_text", text: "Send" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "feedback_block",
              label: { type: "plain_text", text: mode === "fix" ? "What should be changed?" : "How should it be redone?" },
              element: {
                type: "plain_text_input",
                action_id: "feedback_input",
                multiline: true,
                placeholder: { type: "plain_text", text: mode === "fix" ? "e.g. Change button color to blue" : "e.g. Use a completely different approach for the API" },
              },
            },
          ],
        });
      });
    }

    // Modal submissions
    for (const mode of ["fix", "redo"] as const) {
      this.client.onViewSubmission(`feedback_${mode}`, async ({ body, view }) => {
        const meta = JSON.parse(view.private_metadata || "{}");
        const taskKey = meta.taskKey;
        const channel = meta.channel;
        const threadTs = meta.threadTs;
        const feedback = view.state?.values?.feedback_block?.feedback_input?.value?.trim();

        if (!taskKey || !feedback || !this.feedbackHandler) return;

        const replyFn = async (text: string) => {
          if (channel && threadTs) await this.client.replyInThread(channel, threadTs, text);
        };

        await this.feedbackHandler({ taskKey, feedback, mode, replyFn });
      });
    }
  }

  private async handleMessage(message: any): Promise<void> {
    // Filter: bot messages and subtypes (edits, joins, etc.)
    if (message.bot_id || message.subtype) return;

    // Handle non-threaded "status" command
    if (!message.thread_ts || message.thread_ts === message.ts) {
      const text: string = message.text?.trim().toLowerCase() || "";
      if (text === "status" && this.statusHandler) {
        const status = this.statusHandler();
        const lines = [
          `*Worker Status*`,
          `Processing: ${status.processing.length > 0 ? status.processing.join(", ") : "none"}`,
          `Queue: ${status.queueSize} pending feedback(s)`,
          `Stats: ${status.stats.done} done, ${status.stats.failed} failed, ${status.stats.processing} processing`,
        ];
        await this.client.replyInThread(message.channel, message.ts, lines.join("\n"));
        return;
      }
      return; // not a thread reply and not "status" — ignore
    }

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
