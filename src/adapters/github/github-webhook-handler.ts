import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createLogger } from "../../logger.js";
import { toErrorMessage } from "../../utils/errors.js";
import type { GitHubWebhookPayload } from "./github-types.js";

const log = createLogger();

export type WebhookEventHandler = (eventType: string, payload: GitHubWebhookPayload) => void;

export class GitHubWebhookHandler {
  constructor(
    private readonly onEvent: WebhookEventHandler,
    private readonly webhookSecret: string,
  ) {}

  /** HTTP request handler — register on HealthServer at POST /webhooks/github. */
  handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(chunk));

    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);

      // Verify signature if secret is configured
      if (this.webhookSecret) {
        const signature = req.headers["x-hub-signature-256"] as string | undefined;
        if (!this.verifySignature(rawBody, signature)) {
          log.warn("GitHub webhook signature verification failed");
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
      }

      // Return 200 immediately — process asynchronously
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      // Parse and route
      const eventType = req.headers["x-github-event"] as string | undefined;
      if (!eventType) {
        log.debug("GitHub webhook missing X-GitHub-Event header — ignoring");
        return;
      }

      try {
        const payload = JSON.parse(rawBody.toString("utf-8")) as GitHubWebhookPayload;
        this.onEvent(eventType, payload);
      } catch (err) {
        log.warn(`Failed to parse GitHub webhook payload: ${toErrorMessage(err)}`);
      }
    });

    req.on("error", (err) => {
      log.warn(`GitHub webhook request error: ${toErrorMessage(err)}`);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    });
  }

  private verifySignature(body: Buffer, signature: string | undefined): boolean {
    if (!signature) return false;
    const expected = "sha256=" + createHmac("sha256", this.webhookSecret).update(body).digest("hex");
    if (signature.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  }
}
