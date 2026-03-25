# GitHub Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub webhook integration so the worker can receive PR comments (@mentions and CodeRabbit reviews) and execute the same feedback/command flow that currently works via Slack.

**Architecture:** New `github` adapter implementing existing `FeedbackListener` and `Notifier` ports. Webhook endpoint added to the existing `HealthServer`. Composite adapters combine Slack + GitHub listeners/notifiers. Zero changes to core business logic or existing ports. Docker-ready (webhook endpoint exposed via HEALTH_PORT).

**Tech Stack:** Node.js `crypto` for HMAC webhook verification, native `fetch` for GitHub REST API. No new npm dependencies.

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/adapters/github/github-types.ts` | TypeScript types for GitHub webhook payloads |
| `src/adapters/github/github-client.ts` | Low-level GitHub REST API client (post comments, resolve auth user) |
| `src/adapters/github/github-webhook-handler.ts` | HTTP request handler: HMAC verification, body parsing, event routing |
| `src/adapters/github/github-listener.ts` | `FeedbackListener` implementation: maps GitHub comments → `RawFeedback` |
| `src/adapters/github/github-notifier.ts` | `Notifier` implementation: posts task lifecycle events as PR comments |
| ~~`src/adapters/github/index.ts`~~ | ~~Barrel exports~~ — **Removed per clean-code-standards: adapters don't use barrel exports** |
| `src/adapters/composite/composite-feedback-listener.ts` | Combines multiple `FeedbackListener` implementations |
| `src/adapters/composite/composite-notifier.ts` | Primary + secondary `Notifier` pattern |
| ~~`src/adapters/composite/index.ts`~~ | ~~Barrel exports~~ — **Removed per clean-code-standards: adapters don't use barrel exports** |

### Modified Files

| File | Change |
|------|--------|
| `src/config/config.ts` | Add `github` config section (5 env vars) |
| `src/constants.ts` | Add GitHub-specific constants (throttle, debounce) |
| `src/adapters/health/health-server.ts` | Add `registerRoute()` method for webhook endpoint |
| `src/index.ts` | Wire GitHub adapters + composites when enabled |

### Zero Changes To

- `src/ports/*` — all existing ports sufficient
- `src/core/*` — business logic untouched
- `src/adapters/slack/*` — Slack adapter unchanged
- `src/adapters/json-store/*` — store unchanged

---

## Task 1: Config + Constants

**Files:**
- Modify: `src/config/config.ts:15-56`
- Modify: `src/constants.ts`

- [ ] **Step 1: Add GitHub config section to `src/config/config.ts`**

Add after the `slack` section (line 39), before the `worker` section:

```typescript
  // GitHub Integration
  github: {
    enabled: optional("GITHUB_INTEGRATION_ENABLED", "false") === "true",
    webhookSecret: optional("GITHUB_WEBHOOK_SECRET", ""),
    botUsername: optional("GITHUB_BOT_USERNAME", ""),
    reviewBotUsers: optional("GITHUB_REVIEW_BOT_USERS", "coderabbitai[bot]")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
  },
```

- [ ] **Step 2: Add GitHub constants to `src/constants.ts`**

Add at the end of the file:

```typescript
// ─── GitHub Constants ──────────────────────────────────
export const GITHUB_PROGRESS_THROTTLE_MS = 180_000; // 3 min — GitHub API rate limit friendly
export const GITHUB_CODERABBIT_DEBOUNCE_MS = 10_000; // 10s — batch CodeRabbit review comments
export const GITHUB_API_BASE = "https://api.github.com";
```

- [ ] **Step 3: Commit**

```bash
git add src/config/config.ts src/constants.ts
git commit -m "feat: add GitHub integration config and constants"
```

---

## Task 2: GitHub Types

**Files:**
- Create: `src/adapters/github/github-types.ts`

- [ ] **Step 1: Create GitHub webhook payload types**

```typescript
// ─── GitHub Webhook Payload Types ─────────────────────────

export interface GitHubUser {
  login: string;
  id: number;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: GitHubUser;
  html_url: string;
  created_at: string;
}

export interface GitHubPullRequest {
  number: number;
  html_url: string;
  head: { ref: string };
  title: string;
}

export interface GitHubRepository {
  full_name: string;
  owner: { login: string };
  name: string;
}

export interface GitHubIssue {
  number: number;
  html_url: string;
  pull_request?: { html_url: string };
}

/** Covers both `issue_comment` and `pull_request_review_comment` events */
export interface GitHubWebhookPayload {
  action: string;
  comment: GitHubComment;
  repository: GitHubRepository;
  issue?: GitHubIssue;
  pull_request?: GitHubPullRequest;
}

/** Parsed PR reference extracted from a webhook payload or PR URL */
export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/github/github-types.ts
git commit -m "feat: add GitHub webhook payload types"
```

---

## Task 3: GitHub Client

**Files:**
- Create: `src/adapters/github/github-client.ts`

- [ ] **Step 1: Create the GitHub REST API client**

```typescript
import { createLogger } from "../../logger.js";
import { GITHUB_API_BASE } from "../../constants.js";
import type { PrRef } from "./github-types.js";

const log = createLogger();

export interface GitHubClientConfig {
  token: string;
}

export class GitHubClient {
  private readonly token: string;
  private authenticatedUser: string | null = null;

  constructor(config: GitHubClientConfig) {
    this.token = config.token;
  }

  /** Resolve the authenticated user's login (for self-loop prevention). */
  async resolveAuthenticatedUser(): Promise<string> {
    if (this.authenticatedUser) return this.authenticatedUser;

    try {
      const data = await this.request<{ login: string }>("GET", "/user");
      this.authenticatedUser = data.login;
      log.info(`GitHub authenticated as: ${this.authenticatedUser}`);
    } catch {
      log.warn("Could not resolve GitHub authenticated user — self-loop prevention disabled");
      this.authenticatedUser = "";
    }
    return this.authenticatedUser;
  }

  /** Post a comment on a PR (uses the Issues API which works for PRs). */
  async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<void> {
    await this.request("POST", `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, { body });
    log.debug(`Posted comment on ${owner}/${repo}#${issueNumber}`);
  }

  /**
   * Parse a GitHub PR URL into its components.
   * Handles: https://github.com/owner/repo/pull/123
   */
  static parsePrUrl(url: string): PrRef | null {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2], number: parseInt(match[3], 10) };
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${GITHUB_API_BASE}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "jira-ai-worker",
    };
    if (this.token) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${method} ${path} failed (${response.status}): ${text}`);
    }

    if (response.status === 204) return undefined as T;
    return response.json() as Promise<T>;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/github/github-client.ts
git commit -m "feat: add GitHub REST API client"
```

---

## Task 4: Expand HealthServer with Route Registration

**Files:**
- Modify: `src/adapters/health/health-server.ts`

- [ ] **Step 1: Add route registration to HealthServer**

Replace the entire `HealthServer` class with:

```typescript
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { Store } from "../../ports/store.js";
import { createLogger } from "../../logger.js";

const log = createLogger();

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

export class HealthServer {
  private server: Server | null = null;
  private startTime = Date.now();
  private readonly routes = new Map<string, RouteHandler>();

  constructor(
    private port: number,
    private store: Store,
  ) {}

  /** Register a handler for POST requests to a path (e.g. "/webhooks/github"). */
  registerRoute(path: string, handler: RouteHandler): void {
    this.routes.set(path, handler);
    log.info(`Registered route: POST ${path}`);
  }

  async start(): Promise<void> {
    if (this.port <= 0) return;

    this.server = createServer((req, res) => {
      // Health check
      if (req.method === "GET" && req.url === "/health") {
        const stats = this.store.getStats();
        const body = JSON.stringify({
          status: "ok",
          uptime: Math.round((Date.now() - this.startTime) / 1000),
          tasks: stats,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
        return;
      }

      // Registered routes (POST only)
      if (req.method === "POST" && req.url) {
        const handler = this.routes.get(req.url);
        if (handler) {
          handler(req, res);
          return;
        }
      }

      res.writeHead(404);
      res.end("Not Found");
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, () => {
        log.info(`Health check endpoint: http://localhost:${this.port}/health`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/health/health-server.ts
git commit -m "feat: add route registration to HealthServer for webhook support"
```

---

## Task 5: GitHub Webhook Handler

**Files:**
- Create: `src/adapters/github/github-webhook-handler.ts`

- [ ] **Step 1: Create the webhook HTTP handler**

This handles raw HTTP concerns: signature verification, body parsing, event routing.

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/github/github-webhook-handler.ts
git commit -m "feat: add GitHub webhook handler with HMAC signature verification"
```

---

## Task 6: GitHub Listener (FeedbackListener implementation)

**Files:**
- Create: `src/adapters/github/github-listener.ts`

- [ ] **Step 1: Create the GitHub listener**

This is the core adapter — maps GitHub webhook events to `RawFeedback` objects using the same flow as `SlackListener`.

```typescript
import type { FeedbackListener, RawFeedbackHandler, StatusHandler } from "../../ports/feedback-listener.js";
import type { TaskQueryStore } from "../../ports/store.js";
import type { StoredTask } from "../../ports/types.js";
import { GitHubClient } from "./github-client.js";
import { GitHubWebhookHandler, type WebhookEventHandler } from "./github-webhook-handler.js";
import type { GitHubWebhookPayload, PrRef } from "./github-types.js";
import { createLogger } from "../../logger.js";
import { toErrorMessage } from "../../utils/errors.js";
import {
  GITHUB_CODERABBIT_DEBOUNCE_MS,
  CANCEL_COMMANDS,
  CONFIRM_YES_COMMANDS,
  CONFIRM_NO_COMMANDS,
} from "../../constants.js";

const log = createLogger();

export interface GitHubListenerConfig {
  botUsername: string;
  reviewBotUsers: string[];
  webhookSecret: string;
}

interface DebouncedReview {
  taskKey: string;
  prRef: PrRef;
  comments: string[];
  timer: ReturnType<typeof setTimeout>;
}

export class GitHubListener implements FeedbackListener {
  private feedbackHandler: RawFeedbackHandler | null = null;
  private statusHandler: StatusHandler | null = null;
  private readonly webhookHandler: GitHubWebhookHandler;
  private readonly debouncedReviews = new Map<string, DebouncedReview>();
  private authenticatedUser = "";

  constructor(
    private readonly client: GitHubClient,
    private readonly store: TaskQueryStore,
    private readonly config: GitHubListenerConfig,
  ) {
    const onEvent: WebhookEventHandler = (eventType, payload) => this.handleEvent(eventType, payload);
    this.webhookHandler = new GitHubWebhookHandler(onEvent, config.webhookSecret);
  }

  /** Expose the webhook handler for registration on HealthServer. */
  get webhook(): GitHubWebhookHandler {
    return this.webhookHandler;
  }

  onFeedback(handler: RawFeedbackHandler): void {
    this.feedbackHandler = handler;
  }

  onStatusRequest(handler: StatusHandler): void {
    this.statusHandler = handler;
  }

  async start(): Promise<void> {
    this.authenticatedUser = await this.client.resolveAuthenticatedUser();
    log.info("GitHub listener ready (webhook-based)");
  }

  async stop(): Promise<void> {
    // Clear all debounce timers
    for (const review of this.debouncedReviews.values()) {
      clearTimeout(review.timer);
    }
    this.debouncedReviews.clear();
  }

  // ─── Event Routing ───────────────────────────────────────

  private handleEvent(eventType: string, payload: GitHubWebhookPayload): void {
    if (eventType !== "issue_comment" && eventType !== "pull_request_review_comment") {
      log.debug(`Ignoring GitHub event: ${eventType}`);
      return;
    }

    if (payload.action !== "created") {
      log.debug(`Ignoring GitHub comment action: ${payload.action}`);
      return;
    }

    // Process asynchronously — webhook already returned 200
    this.processComment(eventType, payload).catch((err) => {
      log.warn(`Error processing GitHub comment: ${toErrorMessage(err)}`);
    });
  }

  private async processComment(eventType: string, payload: GitHubWebhookPayload): Promise<void> {
    const comment = payload.comment;
    const author = comment.user.login;

    // Self-loop prevention
    if (this.authenticatedUser && author === this.authenticatedUser) return;
    if (this.config.botUsername && author === this.config.botUsername) return;

    // Resolve PR reference
    const prRef = this.extractPrRef(eventType, payload);
    if (!prRef) {
      log.debug("Could not extract PR reference from GitHub webhook — ignoring");
      return;
    }

    // Find matching task by PR URL
    const prUrl = `https://github.com/${prRef.owner}/${prRef.repo}/pull/${prRef.number}`;
    const task = this.findTaskByPrUrl(prUrl);
    if (!task) {
      log.debug(`No tracked task for PR ${prUrl}`);
      return;
    }

    const isReviewBot = this.config.reviewBotUsers.includes(author);
    const isMention = this.config.botUsername
      ? comment.body.includes(`@${this.config.botUsername}`)
      : false;

    if (!isReviewBot && !isMention) {
      log.debug(`GitHub comment by ${author} is not a mention or review bot — ignoring`);
      return;
    }

    log.info(`GitHub ${isReviewBot ? "review bot" : "mention"} comment on ${task.key} by ${author}`);

    if (isReviewBot) {
      this.handleReviewBotComment(task.key, prRef, comment.body);
      return;
    }

    // Human @mention — parse command/feedback
    const text = this.stripMention(comment.body);
    const { feedback, mode, isCommand } = this.parseComment(text);

    if (isCommand && feedback === "status") {
      await this.handleStatusCommand(prRef, task);
      return;
    }

    if (!this.feedbackHandler) {
      log.warn("GitHub listener has no feedback handler registered");
      return;
    }

    const replyFn = async (replyText: string): Promise<void> => {
      await this.client.postComment(prRef.owner, prRef.repo, prRef.number, replyText);
    };

    await this.feedbackHandler({
      taskKey: task.key,
      feedback,
      mode,
      replyFn,
    });
  }

  // ─── CodeRabbit Debounce ─────────────────────────────────

  private handleReviewBotComment(taskKey: string, prRef: PrRef, body: string): void {
    const debounceKey = `${prRef.owner}/${prRef.repo}#${prRef.number}`;
    const existing = this.debouncedReviews.get(debounceKey);

    const scheduleFlush = (): ReturnType<typeof setTimeout> =>
      setTimeout(() => {
        this.flushReviewComments(debounceKey).catch((err) => {
          log.warn(`Failed to flush review comments for ${debounceKey}: ${toErrorMessage(err)}`);
        });
      }, GITHUB_CODERABBIT_DEBOUNCE_MS);

    if (existing) {
      clearTimeout(existing.timer);
      existing.comments.push(body);
      existing.timer = scheduleFlush();
    } else {
      const timer = scheduleFlush();
      this.debouncedReviews.set(debounceKey, {
        taskKey,
        prRef,
        comments: [body],
        timer,
      });
    }
  }

  private async flushReviewComments(debounceKey: string): Promise<void> {
    const review = this.debouncedReviews.get(debounceKey);
    if (!review) return;
    this.debouncedReviews.delete(debounceKey);

    if (!this.feedbackHandler) return;

    const combinedFeedback = review.comments.join("\n\n---\n\n");
    log.info(`Flushing ${review.comments.length} review bot comment(s) for ${review.taskKey}`);

    const replyFn = async (text: string): Promise<void> => {
      await this.client.postComment(review.prRef.owner, review.prRef.repo, review.prRef.number, text);
    };

    await this.feedbackHandler({
      taskKey: review.taskKey,
      feedback: combinedFeedback,
      mode: "fix",
      replyFn,
    });
  }

  // ─── Helpers ─────────────────────────────────────────────

  private extractPrRef(eventType: string, payload: GitHubWebhookPayload): PrRef | null {
    const repo = payload.repository;

    if (eventType === "pull_request_review_comment" && payload.pull_request) {
      return { owner: repo.owner.login, repo: repo.name, number: payload.pull_request.number };
    }

    if (eventType === "issue_comment" && payload.issue?.pull_request) {
      // issue_comment on a PR — extract number from issue
      return { owner: repo.owner.login, repo: repo.name, number: payload.issue.number };
    }

    return null;
  }

  private findTaskByPrUrl(prUrl: string): StoredTask | undefined {
    const normalized = prUrl.replace(/\/$/, "");
    for (const status of ["review", "processing"] as const) {
      const tasks = this.store.getTasksByStatus(status);
      const match = tasks.find((t) => t.prUrl?.replace(/\/$/, "") === normalized);
      if (match) return match;
    }
    return undefined;
  }

  private stripMention(text: string): string {
    if (!this.config.botUsername) return text.trim();
    return text.replace(new RegExp(`@${this.config.botUsername}\\s*`, "gi"), "").trim();
  }

  private parseComment(text: string): { feedback: string; mode: "fix" | "redo"; isCommand: boolean } {
    const lower = text.toLowerCase().trim();

    // Commands — reuse constants from FeedbackCommandHandler
    const commands: readonly string[] = [
      ...CANCEL_COMMANDS, "retry", "status", "reopen",
      ...CONFIRM_YES_COMMANDS, ...CONFIRM_NO_COMMANDS,
    ];
    if (commands.includes(lower)) {
      return { feedback: lower, mode: "fix", isCommand: lower === "status" };
    }

    // Explicit mode prefix
    if (lower.startsWith("fix:")) {
      return { feedback: text.slice(4).trim(), mode: "fix", isCommand: false };
    }
    if (lower.startsWith("redo:")) {
      return { feedback: text.slice(5).trim(), mode: "redo", isCommand: false };
    }

    // Default: bare text = fix mode
    return { feedback: text, mode: "fix", isCommand: false };
  }

  private async handleStatusCommand(prRef: PrRef, task: StoredTask): Promise<void> {
    const status = this.statusHandler?.();
    const lines = [
      `**Task ${task.key}:** ${task.status}`,
      `Feedback rounds: ${task.feedbackRound}`,
      task.prUrl ? `PR: ${task.prUrl}` : "",
      task.error ? `Error: ${task.error.slice(0, 200)}` : "",
      status ? `\nWorker: processing ${status.processing.length}, queue ${status.queueSize}` : "",
    ].filter(Boolean);

    await this.client.postComment(prRef.owner, prRef.repo, prRef.number, lines.join("\n"));
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/github/github-listener.ts
git commit -m "feat: add GitHubListener implementing FeedbackListener port"
```

---

## Task 7: GitHub Notifier

**Files:**
- Create: `src/adapters/github/github-notifier.ts`

- [ ] **Step 1: Create the GitHub notifier**

Posts task lifecycle events as PR comments.

```typescript
import type { Notifier } from "../../ports/notifier.js";
import type { TaskInfo, AIResult, ThreadRef } from "../../ports/types.js";
import type { TaskQueryStore } from "../../ports/store.js";
import { GitHubClient } from "./github-client.js";
import { createLogger } from "../../logger.js";
import { toErrorMessage } from "../../utils/errors.js";
import { GITHUB_PROGRESS_THROTTLE_MS } from "../../constants.js";

const log = createLogger();

export class GitHubNotifier implements Notifier {
  private lastProgressUpdate = new Map<string, number>();

  constructor(
    private readonly client: GitHubClient,
    private readonly store: TaskQueryStore,
  ) {}

  async notifyWorkerStart(): Promise<void> {
    // No-op — GitHub doesn't need a startup notification
  }

  async notifyTaskStarted(_task: TaskInfo): Promise<ThreadRef | undefined> {
    // No-op — PR doesn't exist yet at task start
    return undefined;
  }

  async notifyTaskStatus(thread: ThreadRef, text: string): Promise<void> {
    // Throttle progress updates (GitHub API rate limits)
    const now = Date.now();
    const key = `${thread.channel}:${thread.id}`;
    const lastUpdate = this.lastProgressUpdate.get(key) ?? 0;
    if (now - lastUpdate < GITHUB_PROGRESS_THROTTLE_MS) return;
    this.lastProgressUpdate.set(key, now);

    const prRef = this.resolveThreadRef(thread);
    if (!prRef) return;

    try {
      await this.client.postComment(prRef.owner, prRef.repo, prRef.number, `🔄 ${text}`);
    } catch (err) {
      log.warn(`GitHub progress update failed: ${toErrorMessage(err)}`);
    }
  }

  async notifyTaskCompleted(
    task: TaskInfo,
    result: AIResult,
    _thread?: ThreadRef,
  ): Promise<ThreadRef | undefined> {
    const prRef = result.prUrl ? GitHubClient.parsePrUrl(result.prUrl) : null;
    if (!prRef) return undefined;

    try {
      const duration = (result.durationMs / 1000).toFixed(0);
      const cost = result.costUsd ? ` · Cost: $${result.costUsd.toFixed(2)}` : "";
      await this.client.postComment(
        prRef.owner,
        prRef.repo,
        prRef.number,
        `✅ **Implementation complete** for ${task.key}\nDuration: ${duration}s${cost}\n\nPR is ready for review.`,
      );
      return { id: String(prRef.number), channel: `github:${prRef.owner}/${prRef.repo}` };
    } catch (err) {
      log.warn(`GitHub completion notification failed: ${toErrorMessage(err)}`);
      return undefined;
    }
  }

  async notifyTaskFailed(
    task: TaskInfo,
    error: string,
    _thread?: ThreadRef,
  ): Promise<ThreadRef | undefined> {
    // Try to find the PR from the store
    const storedTask = this.store.getTask(task.key);
    if (!storedTask?.prUrl) return undefined;

    const prRef = GitHubClient.parsePrUrl(storedTask.prUrl);
    if (!prRef) return undefined;

    try {
      await this.client.postComment(
        prRef.owner,
        prRef.repo,
        prRef.number,
        `❌ **Implementation failed** for ${task.key}\n\n\`\`\`\n${error.slice(0, 500)}\n\`\`\``,
      );
      return { id: String(prRef.number), channel: `github:${prRef.owner}/${prRef.repo}` };
    } catch (err) {
      log.warn(`GitHub failure notification failed: ${toErrorMessage(err)}`);
      return undefined;
    }
  }

  async replyInThread(thread: ThreadRef, text: string): Promise<void> {
    const prRef = this.resolveThreadRef(thread);
    if (!prRef) return;

    try {
      await this.client.postComment(prRef.owner, prRef.repo, prRef.number, text);
    } catch (err) {
      log.warn(`GitHub thread reply failed: ${toErrorMessage(err)}`);
    }
  }

  private resolveThreadRef(thread: ThreadRef): { owner: string; repo: string; number: number } | null {
    // ThreadRef format for GitHub: id = PR number, channel = "github:owner/repo"
    if (!thread.channel.startsWith("github:")) return null;
    const repoFullName = thread.channel.slice(7); // strip "github:"
    const parts = repoFullName.split("/");
    if (parts.length !== 2) return null;
    const prNumber = parseInt(thread.id, 10);
    if (isNaN(prNumber)) return null;
    return { owner: parts[0], repo: parts[1], number: prNumber };
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/adapters/github/github-notifier.ts
git commit -m "feat: add GitHubNotifier implementing Notifier port"
```

---

## Task 8: Composite Adapters

**Files:**
- Create: `src/adapters/composite/composite-feedback-listener.ts`
- Create: `src/adapters/composite/composite-notifier.ts`
- Create: `src/adapters/composite/index.ts`

- [ ] **Step 1: Create CompositeFeedbackListener**

```typescript
import type { FeedbackListener, RawFeedbackHandler, StatusHandler } from "../../ports/feedback-listener.js";

export class CompositeFeedbackListener implements FeedbackListener {
  constructor(private readonly listeners: FeedbackListener[]) {}

  onFeedback(handler: RawFeedbackHandler): void {
    for (const listener of this.listeners) {
      listener.onFeedback(handler);
    }
  }

  onStatusRequest(handler: StatusHandler): void {
    for (const listener of this.listeners) {
      listener.onStatusRequest(handler);
    }
  }

  async start(): Promise<void> {
    await Promise.all(this.listeners.map((l) => l.start()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.listeners.map((l) => l.stop()));
  }
}
```

- [ ] **Step 2: Create CompositeNotifier**

```typescript
import type { Notifier } from "../../ports/notifier.js";
import type { TaskInfo, AIResult, ThreadRef } from "../../ports/types.js";
import { createLogger } from "../../logger.js";
import { toErrorMessage } from "../../utils/errors.js";

const log = createLogger();

/**
 * Combines a primary notifier (whose ThreadRef is authoritative) with
 * secondary notifiers that fire-and-forget.
 */
export class CompositeNotifier implements Notifier {
  constructor(
    private readonly primary: Notifier,
    private readonly secondary: Notifier[],
  ) {}

  async notifyWorkerStart(): Promise<void> {
    await this.primary.notifyWorkerStart();
    this.fireSecondary((n) => n.notifyWorkerStart());
  }

  async notifyTaskStarted(task: TaskInfo): Promise<ThreadRef | undefined> {
    const ref = await this.primary.notifyTaskStarted(task);
    this.fireSecondary((n) => n.notifyTaskStarted(task));
    return ref;
  }

  async notifyTaskStatus(thread: ThreadRef, text: string): Promise<void> {
    await this.primary.notifyTaskStatus(thread, text);
    this.fireSecondary((n) => n.notifyTaskStatus(thread, text));
  }

  async notifyTaskCompleted(
    task: TaskInfo,
    result: AIResult,
    thread?: ThreadRef,
  ): Promise<ThreadRef | undefined> {
    const ref = await this.primary.notifyTaskCompleted(task, result, thread);
    this.fireSecondary((n) => n.notifyTaskCompleted(task, result, thread));
    return ref;
  }

  async notifyTaskFailed(
    task: TaskInfo,
    error: string,
    thread?: ThreadRef,
  ): Promise<ThreadRef | undefined> {
    const ref = await this.primary.notifyTaskFailed(task, error, thread);
    this.fireSecondary((n) => n.notifyTaskFailed(task, error, thread));
    return ref;
  }

  async replyInThread(thread: ThreadRef, text: string): Promise<void> {
    await this.primary.replyInThread(thread, text);
    this.fireSecondary((n) => n.replyInThread(thread, text));
  }

  private fireSecondary(fn: (n: Notifier) => Promise<unknown>): void {
    for (const notifier of this.secondary) {
      fn(notifier).catch((err) => {
        log.warn(`Secondary notifier failed: ${toErrorMessage(err)}`);
      });
    }
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/adapters/composite/
git commit -m "feat: add composite FeedbackListener and Notifier adapters"
```

---

## Task 9: Wire Everything in Composition Root

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update imports**

Add these imports at the top of `src/index.ts`, after the existing adapter imports:

```typescript
// GitHub integration
import { GitHubClient } from "./adapters/github/github-client.js";
import { GitHubListener } from "./adapters/github/github-listener.js";
import { GitHubNotifier } from "./adapters/github/github-notifier.js";
import { CompositeFeedbackListener } from "./adapters/composite/composite-feedback-listener.js";
import { CompositeNotifier } from "./adapters/composite/composite-notifier.js";

// Port types (for typed variables)
import type { Notifier } from "./ports/notifier.js";
import type { FeedbackListener } from "./ports/feedback-listener.js";
```

- [ ] **Step 2: Replace the adapter wiring section**

Replace the section from `const slackClient = new SlackClient(...)` through to the `const worker = new Worker(...)` call with:

```typescript
  const slackClient = new SlackClient({
    botToken: config.slack.botToken,
    appToken: config.slack.appToken,
    channel: config.slack.channel,
    webhookUrl: config.slack.webhookUrl,
  });

  const slackNotifier = new SlackNotifier(slackClient);

  const isOnce = process.argv.includes("--once");

  // Start SlackClient (only in continuous mode, if tokens configured)
  let slackListener: SlackListener | null = null;
  if (!isOnce && config.slack.botToken && config.slack.appToken) {
    await slackClient.start();
    slackListener = new SlackListener(slackClient, store);
  }

  // Start health check endpoint (if configured)
  const healthServer = new HealthServer(config.worker.healthPort, store);

  // ─── GitHub Integration ──────────────────────────────────
  let notifier: Notifier = slackNotifier;
  let feedbackListener: FeedbackListener | null = slackListener;

  if (config.github.enabled) {
    logger.info("GitHub integration: enabled");

    if (!config.github.token) {
      logger.warn("GITHUB_TOKEN / GH_TOKEN not set — GitHub API calls will fail");
    }
    if (config.worker.healthPort <= 0) {
      logger.warn("HEALTH_PORT is 0 — GitHub webhook endpoint will not be available. Set HEALTH_PORT to enable.");
    }

    const ghClient = new GitHubClient({ token: config.github.token });
    const ghNotifier = new GitHubNotifier(ghClient, store);
    const ghListener = new GitHubListener(ghClient, store, {
      botUsername: config.github.botUsername,
      reviewBotUsers: config.github.reviewBotUsers,
      webhookSecret: config.github.webhookSecret,
    });

    // Register webhook endpoint on HealthServer
    healthServer.registerRoute("/webhooks/github", (req, res) => ghListener.webhook.handle(req, res));

    // Compose notifiers: Slack primary, GitHub secondary
    notifier = new CompositeNotifier(slackNotifier, [ghNotifier]);

    // Compose feedback listeners
    const listeners: FeedbackListener[] = [];
    if (slackListener) listeners.push(slackListener);
    listeners.push(ghListener);
    feedbackListener = new CompositeFeedbackListener(listeners);

    logger.info(`GitHub webhook: POST http://localhost:${config.worker.healthPort}/webhooks/github`);
    logger.info(`GitHub bot username: ${config.github.botUsername || "(not set)"}`);
    logger.info(`GitHub review bots: ${config.github.reviewBotUsers.join(", ")}`);
  }

  // Start health server (must come after route registration)
  if (config.worker.healthPort > 0) {
    await healthServer.start();
  }

  // ─── Create Core ────────────────────────────────────────
  const pipeline = new TaskPipeline(ai, taskSource, notifier, store, vcs, {
    maxFeedbackRounds: config.worker.maxFeedbackRounds,
  });

  const worker = new Worker(
    pipeline,
    feedbackListener,
    notifier,
    taskSource,
    store,
    vcs,
    ai,
    {
      pollIntervalMs: config.worker.pollIntervalMs,
      maxTurns: config.worker.maxTurns,
      timeoutMs: config.worker.timeoutMs,
      maxFeedbackRounds: config.worker.maxFeedbackRounds,
      maxConcurrent: config.worker.maxConcurrent,
      isOnce,
    },
  );
```

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "feat: wire GitHub integration in composition root"
```

---

## Task 10: Build Verification

- [ ] **Step 1: Run TypeScript build**

```bash
npm run build
```

Expected: clean build, no errors.

- [ ] **Step 2: Fix any TypeScript errors**

If there are errors, fix them and re-run.

- [ ] **Step 3: Commit if fixes were needed**

```bash
git add -A
git commit -m "fix: resolve TypeScript build errors in GitHub integration"
```

---

## Task 11: Manual Smoke Test

- [ ] **Step 1: Test webhook endpoint responds**

Start the worker with GitHub enabled:

```bash
GITHUB_INTEGRATION_ENABLED=true HEALTH_PORT=8080 npm run dev
```

In another terminal:

```bash
curl -s -X POST http://localhost:8080/webhooks/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: issue_comment" \
  -d '{"action":"created","comment":{"id":1,"body":"test","user":{"login":"testuser","id":1},"html_url":"","created_at":""},"repository":{"full_name":"test/repo","owner":{"login":"test"},"name":"repo"},"issue":{"number":1,"html_url":"","pull_request":{"html_url":"https://github.com/test/repo/pull/1"}}}'
```

Expected: HTTP 200 `{"ok":true}`, worker log shows "No tracked task for PR".

- [ ] **Step 2: Test health endpoint still works**

```bash
curl -s http://localhost:8080/health | python3 -m json.tool
```

Expected: JSON with `status: "ok"`.

- [ ] **Step 3: Test with GitHub disabled (default)**

Start without `GITHUB_INTEGRATION_ENABLED`:

```bash
HEALTH_PORT=8080 npm run dev
```

Verify no GitHub-related log output, webhook endpoint returns 404.

---

## Docker Considerations

The webhook approach is Docker-ready by design:

1. **HEALTH_PORT** is already the exposed port — just add `EXPOSE ${HEALTH_PORT}` to Dockerfile
2. GitHub webhook URL points to `https://<your-domain>:<port>/webhooks/github`
3. All config via env vars — standard Docker practice
4. No local filesystem dependencies for the GitHub adapter

Example `docker-compose.yml` addition:

```yaml
services:
  jira-ai-worker:
    environment:
      - GITHUB_INTEGRATION_ENABLED=true
      - GITHUB_WEBHOOK_SECRET=${GITHUB_WEBHOOK_SECRET}
      - GITHUB_BOT_USERNAME=${GITHUB_BOT_USERNAME}
      - GITHUB_TOKEN=${GITHUB_TOKEN}
      - HEALTH_PORT=8080
    ports:
      - "8080:8080"
```
