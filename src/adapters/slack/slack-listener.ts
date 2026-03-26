import type {
  FeedbackListener,
  RawFeedbackHandler,
  StatusHandler,
  TaskRunRequestHandler,
} from "../../ports/feedback-listener.js";
import type { Store } from "../../ports/store.js";
import { SlackClient } from "./slack-client.js";
import { createLogger } from "../../logger.js";
import { buildActionButtons, STATUS_EMOJI } from "./slack-ui.js";
import { MAX_TASK_LIST_DISPLAY } from "../../constants.js";
import type { SlackActionPayload, SlackViewSubmissionPayload, SlackMessageEvent } from "./slack-types.js";
import { extractJiraIssueKeyFromText } from "../../utils/extract-jira-issue-key.js";
import { parseRetryTicketKey } from "../../utils/parse-retry-channel-message.js";

const log = createLogger();

export class SlackListener implements FeedbackListener {
  private readonly client: SlackClient;
  private readonly store: Store;
  private readonly jiraProjectKey: string;
  private readonly jiraBaseUrl: string;
  private feedbackHandler: RawFeedbackHandler | null = null;
  private statusHandler: StatusHandler | null = null;
  private taskRunHandler: TaskRunRequestHandler | null = null;

  constructor(client: SlackClient, store: Store, jiraProjectKey: string, jiraBaseUrl: string) {
    this.client = client;
    this.store = store;
    this.jiraProjectKey = jiraProjectKey;
    this.jiraBaseUrl = jiraBaseUrl.replace(/\/$/, "");
  }

  onFeedback(handler: RawFeedbackHandler): void {
    this.feedbackHandler = handler;
  }

  onStatusRequest(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  onTaskRunRequest(handler: TaskRunRequestHandler): void {
    this.taskRunHandler = handler;
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
        const action = (body as SlackActionPayload).actions?.[0];
        const taskKey = action?.value;
        if (!taskKey || !this.feedbackHandler) return;

        const channel = (body as SlackActionPayload).channel?.id;
        const threadTs = (body as SlackActionPayload).message?.thread_ts || (body as SlackActionPayload).message?.ts;
        const messageTs = (body as SlackActionPayload).message?.ts;
        const feedback = cmd === "task_cancel" ? "cancel" : "retry";

        // Remove buttons from the clicked message
        if (channel && messageTs) {
          const label = cmd === "task_cancel" ? "Cancelling..." : "Retrying...";
          await this.client.updateMessage(channel, messageTs, [
            { type: "section", text: { type: "mrkdwn", text: `_${label}_` } },
          ], label);
        }

        const replyFn = async (text: string) => {
          if (channel && threadTs) await this.client.replyInThread(channel, threadTs, text);
        };

        await this.feedbackHandler({ taskKey, feedback, mode: "fix", replyFn });
      });
    }

    // Status button — reply with task info + re-post action buttons
    this.client.onAction("task_status", async ({ body }) => {
      const action = (body as SlackActionPayload).actions?.[0];
      const taskKey = action?.value;
      if (!taskKey) return;

      const channel = (body as SlackActionPayload).channel?.id;
      const threadTs = (body as SlackActionPayload).message?.thread_ts || (body as SlackActionPayload).message?.ts;
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
      await this.client.replyInThreadWithBlocks(channel, threadTs, [
        { type: "actions", elements: buildActionButtons(taskKey, task.status) } as any,
      ], "Task actions");
    });

    // Open button — creates new thread for task with action buttons
    this.client.onAction("task_open", async ({ body }) => {
      const action = (body as SlackActionPayload).actions?.[0];
      const taskKey = action?.value;
      if (!taskKey) return;

      const channel = (body as SlackActionPayload).channel?.id;
      if (!channel) return;

      const task = this.store.getTask(taskKey);
      if (!task) return;

      const emoji = STATUS_EMOJI[task.status] || "❓";
      const summary = task.taskInfo?.summary || taskKey;

      // Post new main message for this task
      const posted = await this.client.postMessage(channel, [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `${emoji} *${taskKey}: ${summary}*\nStatus: ${task.status} · Rounds: ${task.feedbackRound}${task.prUrl ? ` · <${task.prUrl}|PR>` : ""}`,
          },
        },
      ], `${taskKey}: ${summary}`);

      // Post action buttons in thread
      await this.client.replyInThreadWithBlocks(posted.channel, posted.ts, [
        { type: "actions", elements: buildActionButtons(taskKey, task.status) } as any,
      ], "Task actions");

      // Update store with new thread ref so future button clicks work
      this.store.setThreadRef(taskKey, { id: posted.ts, channel: posted.channel });
    });

    // Fix/Redo buttons — open modal for user to type feedback
    for (const mode of ["fix", "redo"] as const) {
      this.client.onAction(`task_${mode}`, async ({ body }) => {
        const action = (body as SlackActionPayload).actions?.[0];
        const taskKey = action?.value;
        const triggerId = (body as SlackActionPayload).trigger_id;
        if (!taskKey || !triggerId) return;

        const messageTs = (body as SlackActionPayload).message?.ts;
        const threadTs = (body as SlackActionPayload).message?.thread_ts || messageTs;
        const channel = (body as SlackActionPayload).channel?.id;

        await this.client.openModal(triggerId, {
          type: "modal",
          callback_id: `feedback_${mode}`,
          private_metadata: JSON.stringify({ taskKey, channel, threadTs, buttonMessageTs: messageTs }),
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
        const buttonMessageTs = meta.buttonMessageTs;
        const feedback = view.state?.values?.feedback_block?.feedback_input?.value?.trim();

        if (!taskKey || !feedback || !this.feedbackHandler) return;

        // Update the original button message to Cancel-only
        if (channel && buttonMessageTs) {
          await this.client.updateMessage(channel, buttonMessageTs, [
            { type: "section", text: { type: "mrkdwn", text: `🔄 _Processing ${mode} feedback..._` } },
            { type: "actions", elements: [
              { type: "button", text: { type: "plain_text", text: "🛑 Cancel" }, action_id: "task_cancel", value: taskKey, style: "danger" },
            ] } as any,
          ], "Processing...");
        }

        const replyFn = async (text: string) => {
          if (channel && threadTs) await this.client.replyInThread(channel, threadTs, text);
        };

        await this.feedbackHandler({ taskKey, feedback, mode, replyFn });
      });
    }
  }

  /**
   * Matches messages like "retry mp-571", "retry 571", "retyr MP-123" and runs the same path as the Retry button.
   */
  /**
   * Pasted browse URL (matching JIRA_BASE_URL) or bare PROJECT-123 → worker fetches issue and may start / cleanup like retry.
   */
  private async maybeHandleJiraLinkMessage(message: SlackMessageEvent): Promise<boolean> {
    const rawText = message.text ?? "";
    const issueKey = extractJiraIssueKeyFromText(rawText, this.jiraBaseUrl, this.jiraProjectKey);
    log.debug(
      `maybeHandleJiraLinkMessage: extracted issueKey=${issueKey ?? "null"} ` +
        `rawText=${JSON.stringify(rawText.slice(0, 200))}`,
    );
    if (!issueKey) return false;
    if (!this.taskRunHandler) {
      log.debug("maybeHandleJiraLinkMessage: taskRunHandler not set, ignoring trigger");
      return false;
    }

    const bypassJiraStatusCheck =
      /\bretry\b/i.test(rawText) || /\bretyr\b/i.test(rawText);

    log.info(
      `Slack JIRA link / key trigger for ${issueKey}` +
        (bypassJiraStatusCheck ? " (bypass JIRA status checks)" : ""),
    );

    const channel = message.channel as string;
    const threadTs =
      message.thread_ts && message.thread_ts !== message.ts
        ? (message.thread_ts as string)
        : (message.ts as string);

    const replyFn = async (text: string) => {
      await this.client.replyInThread(channel, threadTs, text);
    };

    await this.taskRunHandler({ issueKey, replyFn, bypassJiraStatusCheck });
    return true;
  }

  private async maybeHandleRetryChannelMessage(message: SlackMessageEvent): Promise<boolean> {
    const rawText = message.text ?? "";
    const hasRetryWord = /\bretry\b/i.test(rawText) || /\bretyr\b/i.test(rawText);
    log.debug(
      `maybeHandleRetryChannelMessage: hasRetryWord=${hasRetryWord} ` +
        `rawText=${JSON.stringify(rawText.slice(0, 200))} ` +
        `taskRunHandler=${Boolean(this.taskRunHandler)} feedbackHandler=${Boolean(this.feedbackHandler)} ` +
        `channel=${String(message.channel ?? "none")} ` +
        `thread_ts=${message.thread_ts ?? "none"} ts=${String(message.ts ?? "none")}`,
    );

    const ticketKey = parseRetryTicketKey(rawText, this.jiraProjectKey);
    log.debug(`maybeHandleRetryChannelMessage: parsed ticketKey=${ticketKey ?? "null"}`);
    if (!ticketKey) {
      return false;
    }

    const channel = message.channel as string;
    const threadTs =
      message.thread_ts && message.thread_ts !== message.ts
        ? (message.thread_ts as string)
        : (message.ts as string);

    const replyFn = async (text: string) => {
      await this.client.replyInThread(channel, threadTs, text);
    };

    if (this.taskRunHandler) {
      log.info(
        `Channel retry command for ${ticketKey} (manual run, JIRA status bypass)` +
          ` (storeTracked=${Boolean(this.store.getTask(ticketKey))})`,
      );
      await this.taskRunHandler({
        issueKey: ticketKey,
        replyFn,
        bypassJiraStatusCheck: true,
      });
      return true;
    }

    if (!this.feedbackHandler) {
      log.warn(
        "parseRetryTicketKey matched but neither taskRunHandler nor feedbackHandler is set",
      );
      return false;
    }

    if (!this.store.getTask(ticketKey)) {
      await replyFn(`No tracked task *${ticketKey}* in worker state.`);
      return true;
    }

    log.info(`Channel retry command for ${ticketKey} (feedback handler fallback)`);
    await this.feedbackHandler({
      taskKey: ticketKey,
      feedback: "retry",
      mode: "fix",
      replyFn,
    });
    return true;
  }

  private async handleMessage(message: SlackMessageEvent): Promise<void> {
    // Filter: bot messages and subtypes (edits, joins, etc.)
    const rawText = message.text ?? "";
    log.info(
      `handleMessage: bot_id=${message.bot_id ? "yes" : "no"} ` +
        `subtype=${message.subtype ?? "none"} ` +
        `channel=${String(message.channel ?? "none")} ` +
        `thread_ts=${message.thread_ts ?? "none"} ts=${String(message.ts ?? "none")} ` +
        `text=${JSON.stringify(rawText.slice(0, 250))}`,
    );
    if (message.bot_id || message.subtype) {
      log.debug(
        `handleMessage: filtered out (bot_id=${Boolean(message.bot_id)} subtype=${message.subtype ?? "none"})`,
      );
      return;
    }

    if (await this.maybeHandleRetryChannelMessage(message)) {
      return;
    }

    if (await this.maybeHandleJiraLinkMessage(message)) {
      return;
    }

    // Channel-level messages (not in a thread)
    if (!message.thread_ts || message.thread_ts === message.ts) {
      const text: string = message.text?.trim().toLowerCase() || "";
      const botId = this.client.botId;
      const isMention = botId ? text.includes(`<@${botId.toLowerCase()}>`) || message.text?.includes(`<@${botId}>`) : false;

      if ((text === "status" || isMention) && this.statusHandler) {
        await this.postTaskList(message.channel, message.ts);
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
      await this.client.replyInThreadWithBlocks(channel, threadTs, [
        { type: "actions", elements: buildActionButtons(task.key, task.status) } as any,
      ], "Task actions");
      return;
    }

    // All other thread text is ignored — use buttons
    log.debug(`Ignoring thread text (use buttons): "${text.slice(0, 50)}"`);
  }

  private async postTaskList(channel: string, replyTs: string): Promise<void> {
    const status = this.statusHandler?.();
    if (!status) return;

    const blocks: any[] = [
      {
        type: "section",
        text: { type: "mrkdwn", text: `*Worker Status*\nProcessing: ${status.processing.length || 0} · Review: ${status.stats.review} · Done: ${status.stats.done} · Failed: ${status.stats.failed}` },
      },
      { type: "divider" },
    ];

    // Show all tasks (processing, done, failed) — most recent first
    const allTasks = [
      ...this.store.getTasksByStatus("processing"),
      ...this.store.getTasksByStatus("review"),
      ...this.store.getTasksByStatus("failed"),
      ...this.store.getTasksByStatus("done"),
    ];

    if (allTasks.length === 0) {
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: "No tasks tracked yet." },
      });
    } else {
      for (const task of allTasks.slice(0, MAX_TASK_LIST_DISPLAY)) {
        const emoji = STATUS_EMOJI[task.status] || "❓";
        const summary = task.taskInfo?.summary || task.key;
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: `${emoji} *${task.key}* — ${task.status}\n${summary.slice(0, 80)}` },
          accessory: {
            type: "button",
            text: { type: "plain_text", text: "Open" },
            action_id: "task_open",
            value: task.key,
          },
        });
      }
    }

    await this.client.replyInThreadWithBlocks(channel, replyTs, blocks, "Task list");
  }

}
