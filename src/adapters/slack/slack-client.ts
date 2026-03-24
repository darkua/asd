// CJS packages need default import for Node ESM compatibility
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);

const { App, LogLevel }: typeof import("@slack/bolt") = _require("@slack/bolt");

import { createLogger } from "../../logger.js";

const log = createLogger();

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  elements?: Array<{
    type: string;
    text?: string | { type: string; text: string };
    url?: string;
  }>;
  fields?: Array<{ type: string; text: string }>;
}

export interface SlackClientConfig {
  botToken: string;
  appToken: string;
  channel: string;
  webhookUrl: string;
}

import type { SlackMessageEvent } from "./slack-types.js";

type MessageHandler = (message: SlackMessageEvent) => Promise<void>;

export class SlackClient {
  readonly channel: string;
  readonly webhookUrl: string;

  private app: InstanceType<typeof App> | null = null;
  private botUserId: string | null = null;
  private readonly config: SlackClientConfig;

  constructor(config: SlackClientConfig) {
    this.config = config;
    this.channel = config.channel;
    this.webhookUrl = config.webhookUrl;
  }

  get isActive(): boolean {
    return this.app !== null;
  }

  get botId(): string | null {
    return this.botUserId;
  }

  async start(): Promise<void> {
    if (!this.config.botToken || !this.config.appToken) {
      log.info("Slack feedback disabled — bot tokens not configured");
      return;
    }

    this.app = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      socketMode: true,
      logLevel: LogLevel.WARN,
    });

    // Get own bot user ID to filter out own messages
    const authResult = await this.app.client.auth.test();
    this.botUserId = authResult.user_id || null;
    log.info(`Slack bot connected as user ${this.botUserId}`);

    // Log ALL incoming events for diagnostics
    this.app.use(async (args: any) => {
      const event = args.event;
      if (event) {
        log.debug(
          `Slack event received: type=${event.type}, subtype=${event.subtype || "none"}`,
        );
      }
      await args.next();
    });

    await this.app.start();
    log.info("Slack Bot started in Socket Mode");
    log.info(
      "NOTE: Ensure Slack App has Event Subscriptions enabled: message.channels (public) and/or message.groups (private)",
    );
  }

  async stop(): Promise<void> {
    if (this.app) {
      await this.app.stop();
      this.app = null;
      log.info("Slack Bot stopped");
    }
  }

  onMessage(handler: MessageHandler): void {
    if (!this.app) return;

    this.app.message(async ({ message }: any) => {
      const msg = message as SlackMessageEvent;
      log.debug(
        `app.message() fired: ts=${msg.ts}, thread_ts=${msg.thread_ts || "none"}`,
      );
      await handler(msg);
    });
  }

  async postMessage(
    channel: string,
    blocks: SlackBlock[],
    text?: string,
  ): Promise<{ ts: string; channel: string }> {
    if (!this.app) throw new Error("Slack bot not active");

    const result = await this.app.client.chat.postMessage({
      channel,
      blocks: blocks as any,
      text: text || "",
    });

    return { ts: result.ts!, channel: result.channel! };
  }

  async replyInThread(
    channel: string,
    threadTs: string,
    text: string,
  ): Promise<void> {
    if (!this.app) return;

    await this.app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text,
    });
  }

  async updateMessage(
    channel: string,
    ts: string,
    blocks: SlackBlock[],
    text?: string,
  ): Promise<void> {
    if (!this.app) return;

    try {
      await this.app.client.chat.update({
        channel,
        ts,
        blocks: blocks as any,
        text: text || "",
      });
    } catch (err) {
      log.warn(`Failed to update Slack message: ${err}`);
    }
  }

  onAction(actionId: string, handler: (payload: any) => Promise<void>): void {
    if (!this.app) return;
    this.app.action(actionId, async ({ ack, body, action }: any) => {
      await ack();
      await handler({ body, action });
    });
  }

  onViewSubmission(
    callbackId: string,
    handler: (payload: any) => Promise<void>,
  ): void {
    if (!this.app) return;
    this.app.view(callbackId, async ({ ack, body, view }: any) => {
      await ack();
      await handler({ body, view });
    });
  }

  async openModal(
    triggerId: string,
    view: Record<string, unknown>,
  ): Promise<void> {
    if (!this.app) return;
    await this.app.client.views.open({
      trigger_id: triggerId,
      view: view as any,
    });
  }

  async replyInThreadWithBlocks(
    channel: string,
    threadTs: string,
    blocks: SlackBlock[],
    text?: string,
  ): Promise<void> {
    if (!this.app) return;
    await this.app.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      blocks: blocks as any,
      text: text || "",
    });
  }

  async sendWebhook(payload: Record<string, unknown>): Promise<void> {
    if (!this.webhookUrl) return;

    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        log.warn(`Slack webhook returned ${response.status}`);
      }
    } catch (err) {
      log.warn(`Slack webhook notification failed: ${err}`);
    }
  }
}
