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
    for (const cmd of ["task_cancel", "task_retry"] as const) {
      this.client.onAction(cmd, async ({ body }) => {
        const action = (body as any).actions?.[0];
        const taskKey = action?.value;
        if (!taskKey || !this.feedbackHandler) return;

        const channel = (body as any).channel?.id;
        const threadTs = (body as any).message?.thread_ts || (body as any).message?.ts;
        const feedback = cmd === "task_cancel" ? "cancel" : "retry";

        const replyFn = async (text: string) => {
          if (channel && threadTs) await this.client.replyInThread(channel, threadTs, text);
        };

        await this.feedbackHandler({ taskKey, feedback, mode: "fix", replyFn });
      });
    }

    // Status button — reply with task info + re-post action buttons
    this.client.onAction("task_status", async ({ body }) => {
      const action = (body as any).actions?.[0];
      const taskKey = action?.value;
      if (!taskKey) return;

      const channel = (body as any).channel?.id;
      const threadTs = (body as any).message?.thread_ts || (body as any).message?.ts;
      if (!channel || !threadTs) return;

      const task = this.store.getTask(taskKey);
      if (!task) return;

      // Post status info
      const lines = [
        `*Task ${taskKey}:* ${task.status}`,
        `Feedback rounds: ${task.feedbackRound}`,
        task.prUrl ? `PR: <${task.prUrl}|View>` : "",
        task.error ? `Error: ${task.error.slice(0, 100)}` : "",
      ].filter(Boolean);
      await this.client.replyInThread(channel, threadTs, lines.join("\n"));

      // Re-post action buttons
      const buttons: any[] = [
        { type: "button", text: { type: "plain_text", text: "🔧 Fix" }, action_id: "task_fix", value: taskKey, style: "primary" },
        { type: "button", text: { type: "plain_text", text: "🔄 Redo" }, action_id: "task_redo", value: taskKey },
        { type: "button", text: { type: "plain_text", text: "📊 Status" }, action_id: "task_status", value: taskKey },
      ];
      if (task.status === "failed") {
        buttons.push({ type: "button", text: { type: "plain_text", text: "🔁 Retry" }, action_id: "task_retry", value: taskKey });
      }
      buttons.push({ type: "button", text: { type: "plain_text", text: "🛑 Cancel" }, action_id: "task_cancel", value: taskKey, style: "danger" });

      await this.client.replyInThreadWithBlocks(channel, threadTs, [{ type: "actions", elements: buttons } as any], "Task actions");
    });

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

    // Handle non-threaded "status" command in channel
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
      }
      return;
    }

    // In threads: only respond to bot mention or "status" — post action buttons
    const text: string = message.text?.trim() || "";
    const botId = this.client.botId;
    const isMention = botId ? text.includes(`<@${botId}>`) : false;
    const isStatus = text.toLowerCase() === "status";

    if (isMention || isStatus) {
      const task = this.store.getTaskByThread(message.thread_ts);
      if (!task) return;

      const channel = message.channel as string;
      const threadTs = message.thread_ts as string;

      // Post status info
      const lines = [
        `*Task ${task.key}:* ${task.status}`,
        `Feedback rounds: ${task.feedbackRound}`,
        task.prUrl ? `PR: <${task.prUrl}|View>` : "",
        task.error ? `Error: ${task.error.slice(0, 100)}` : "",
      ].filter(Boolean);
      await this.client.replyInThread(channel, threadTs, lines.join("\n"));

      // Post action buttons
      const buttons: any[] = [
        { type: "button", text: { type: "plain_text", text: "🔧 Fix" }, action_id: "task_fix", value: task.key, style: "primary" },
        { type: "button", text: { type: "plain_text", text: "🔄 Redo" }, action_id: "task_redo", value: task.key },
        { type: "button", text: { type: "plain_text", text: "📊 Status" }, action_id: "task_status", value: task.key },
      ];
      if (task.status === "failed") {
        buttons.push({ type: "button", text: { type: "plain_text", text: "🔁 Retry" }, action_id: "task_retry", value: task.key });
      }
      buttons.push({ type: "button", text: { type: "plain_text", text: "🛑 Cancel" }, action_id: "task_cancel", value: task.key, style: "danger" });

      await this.client.replyInThreadWithBlocks(channel, threadTs, [{ type: "actions", elements: buttons } as any], "Task actions");
      return;
    }

    // All other thread text is ignored — use buttons
    log.debug(`Ignoring thread text (use buttons): "${text.slice(0, 50)}"`);
  }
}
