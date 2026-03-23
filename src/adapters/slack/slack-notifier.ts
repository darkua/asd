import type { Notifier } from "../../ports/notifier.js";
import type { TaskInfo, AIResult, ThreadRef } from "../../ports/types.js";
import { SlackClient, type SlackBlock } from "./slack-client.js";
import { createLogger } from "../../logger.js";

const log = createLogger();

export class SlackNotifier implements Notifier {
  private readonly client: SlackClient;

  constructor(client: SlackClient) {
    this.client = client;
  }

  async notifyWorkerStart(): Promise<void> {
    const text = `JIRA AI Worker started.`;

    if (this.client.isActive && this.client.channel) {
      await this.client.postMessage(this.client.channel, [
        { type: "section", text: { type: "mrkdwn", text } },
      ], text);
      return;
    }

    if (this.client.webhookUrl) {
      await this.client.sendWebhook({ text });
    }
  }

  async notifyTaskStarted(task: TaskInfo): Promise<ThreadRef | undefined> {
    if (!this.client.isActive || !this.client.channel) return undefined;

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

      const posted = await this.client.postMessage(
        this.client.channel,
        mainBlocks,
        `🔧 ${task.key}: ${task.summary}`,
      );

      // Post JIRA link in thread immediately
      await this.client.replyInThread(
        posted.channel,
        posted.ts,
        `📋 JIRA: <${task.url}|${task.key}>`,
      );

      return { id: posted.ts, channel: posted.channel };
    } catch (err) {
      log.warn(`Slack Bolt notification failed, falling back to webhook mode: ${err}`);
      return undefined;
    }
  }

  async notifyTaskStatus(thread: ThreadRef, text: string): Promise<void> {
    if (!thread.channel || !thread.id || !this.client.isActive) return;

    try {
      await this.client.replyInThread(thread.channel, thread.id, text);
    } catch (err) {
      log.warn(`Slack thread status update failed: ${err}`);
    }
  }

  async notifyTaskCompleted(
    task: TaskInfo,
    result: AIResult,
    thread?: ThreadRef,
  ): Promise<ThreadRef | undefined> {
    // Bolt thread mode
    if (thread?.channel && thread?.id && this.client.isActive) {
      try {
        // Post success in thread
        await this.client.replyInThread(
          thread.channel,
          thread.id,
          `✅ PR created: <${result.prUrl}|View Pull Request>\nDuration: ${(result.durationMs / 1000).toFixed(0)}s`,
        );

        // Update main message
        await this.client.updateMessage(thread.channel, thread.id, [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*✅ ${task.key}: ${task.summary} — Done*\nPriority: ${task.priority} · Type: ${task.issueType}`,
            },
          },
        ], `${task.key}: ${task.summary} — Done`);

        return thread;
      } catch (err) {
        log.warn(`Slack Bolt completion notification failed, falling back to webhook: ${err}`);
      }
    }

    // Webhook fallback
    return this.notifySuccessWebhook(task, result);
  }

  async notifyTaskFailed(
    task: TaskInfo,
    error: string,
    thread?: ThreadRef,
  ): Promise<ThreadRef | undefined> {
    // Bolt thread mode
    if (thread?.channel && thread?.id && this.client.isActive) {
      try {
        // Post failure in thread
        await this.client.replyInThread(
          thread.channel,
          thread.id,
          `❌ Implementation failed:\n\`\`\`${error.slice(0, 500)}\`\`\``,
        );

        // Update main message
        await this.client.updateMessage(thread.channel, thread.id, [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*❌ ${task.key}: ${task.summary} — Failed*\nPriority: ${task.priority} · Type: ${task.issueType}`,
            },
          },
        ], `${task.key}: ${task.summary} — Failed`);

        return thread;
      } catch (err) {
        log.warn(`Slack Bolt failure notification failed, falling back to webhook: ${err}`);
      }
    }

    // Webhook fallback
    return this.notifyFailureWebhook(task, error);
  }

  async replyInThread(thread: ThreadRef, text: string): Promise<void> {
    if (!thread.channel || !thread.id || !this.client.isActive) return;

    try {
      await this.client.replyInThread(thread.channel, thread.id, text);
    } catch (err) {
      log.warn(`Slack thread reply failed: ${err}`);
    }
  }

  // ─── Private webhook fallbacks ──────────────────────────────

  private async notifySuccessWebhook(
    task: TaskInfo,
    result: AIResult,
  ): Promise<ThreadRef | undefined> {
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

    if (this.client.isActive && this.client.channel) {
      const posted = await this.client.postMessage(
        this.client.channel,
        blocks,
        `AI implementation complete: ${task.key}`,
      );
      return { id: posted.ts, channel: posted.channel };
    }

    if (this.client.webhookUrl) {
      await this.client.sendWebhook({ blocks });
    }

    return undefined;
  }

  private async notifyFailureWebhook(
    task: TaskInfo,
    error: string,
  ): Promise<ThreadRef | undefined> {
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

    if (this.client.isActive && this.client.channel) {
      const posted = await this.client.postMessage(
        this.client.channel,
        blocks,
        `AI implementation failed: ${task.key}`,
      );
      return { id: posted.ts, channel: posted.channel };
    }

    if (this.client.webhookUrl) {
      await this.client.sendWebhook({ blocks });
    }

    return undefined;
  }
}
