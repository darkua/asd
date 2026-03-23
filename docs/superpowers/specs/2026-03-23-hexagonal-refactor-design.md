# Hexagonal Architecture Refactor — Design Spec

## Problem

The codebase has 9 flat files in `src/` with tight coupling between all modules. `index.ts` (13KB) owns orchestration, feedback handling, queue logic, and the polling loop. Every module imports directly from every other module. Adding new integrations (GitHub, different AI backends, web dashboard, multiple repos) requires touching core logic.

## Goals

1. Decouple core pipeline logic from external integrations (Slack, JIRA, Claude, Git, JSON store)
2. Make integrations swappable via interfaces (ports) and implementations (adapters)
3. Support multiple simultaneous adapters per port (e.g., Slack + GitHub notifications)
4. Keep JSON file store behind an abstraction for future DB migration
5. Make core logic testable without any external dependencies

## Non-Goals

- Adding new integrations (GitHub, web dashboard) — this refactor prepares the architecture
- Changing persistence from JSON to a database
- Adding new features or changing business logic

## Architecture: Ports & Adapters (Hexagonal)

Core domain logic depends only on port interfaces. Adapters implement ports for specific technologies. A single composition root wires adapters to core at startup.

```
                    ┌─────────────────────────────┐
                    │        Composition Root      │
                    │         (src/index.ts)        │
                    └──────────┬──────────────────┘
                               │ wires
          ┌────────────────────┼────────────────────┐
          │                    │                     │
   ┌──────▼──────┐    ┌───────▼───────┐    ┌───────▼───────┐
   │   Adapters   │    │     Core      │    │    Config     │
   │              │◄───│               │───►│               │
   │ claude/      │    │ TaskPipeline  │    │ Validated     │
   │ jira/        │    │ Worker        │    │ typed config  │
   │ slack/       │    │               │    │               │
   │ git/         │    │ depends ONLY  │    └───────────────┘
   │ json-store/  │    │ on ports/     │
   └──────────────┘    └───────┬───────┘
                               │ imports
                        ┌──────▼──────┐
                        │    Ports     │
                        │ (interfaces) │
                        └─────────────┘
```

**Dependency rule**: Core imports ports. Adapters import ports. Core never imports adapters. Adapters never import each other.

## Port Interfaces

### AIProvider

Abstracts the AI execution engine. Today: Claude Code CLI. Tomorrow: OpenAI, local LLM, etc.

```typescript
interface AIProvider {
  run(task: TaskInfo, workDir: string): Promise<AIResult>;
  runWithFeedback(task: TaskInfo, workDir: string, feedback: FeedbackRequest): Promise<AIResult>;
  kill(pid: number): Promise<void>;
}

interface AIResult {
  success: boolean;
  result: string;
  prUrl: string | null;
  exitCode: number | null;
  durationMs: number;
  raw: string;
  pid?: number;  // returned to core so it can track/kill the process via Store
}

interface FeedbackRequest {
  feedback: string;
  mode: "fix" | "redo";
  round: number;
  maxRounds: number;
}
```

**PID tracking**: The AI adapter returns `pid` in `AIResult`. The core pipeline stores it via `Store.setChildPid()` and passes it to `AIProvider.kill()` when needed. The adapter itself does NOT touch the store — PID lifecycle is owned by core.

### TaskSource

Abstracts where tasks come from. Today: JIRA polling. Tomorrow: GitHub Issues, webhooks, web dashboard.

```typescript
interface TaskSource {
  poll(): Promise<TaskInfo[]>;
  transitionToInProgress(key: string): Promise<void>;
  transitionToReview(key: string): Promise<void>;
  addComment(key: string, body: string): Promise<void>;
}

interface TaskInfo {
  key: string;
  summary: string;
  description: string;
  issueType: string;
  priority: string;
  url: string;
}
```

### Notifier

Pushes status notifications outward. Today: Slack. Tomorrow: GitHub PR comments, web dashboard, email.

```typescript
interface ThreadRef {
  id: string;      // thread_ts for Slack, comment ID for GitHub, etc.
  channel: string;  // channel ID for Slack, repo for GitHub, etc.
}

interface Notifier {
  notifyWorkerStart(): Promise<void>;
  notifyTaskStarted(task: TaskInfo): Promise<ThreadRef | undefined>;
  notifyTaskStatus(thread: ThreadRef, text: string): Promise<void>;
  notifyTaskCompleted(task: TaskInfo, result: AIResult, thread?: ThreadRef): Promise<ThreadRef | undefined>;
  notifyTaskFailed(task: TaskInfo, error: string, thread?: ThreadRef): Promise<ThreadRef | undefined>;
  replyInThread(thread: ThreadRef, text: string): Promise<void>;
}
```

**Webhook fallback**: The existing Slack code has a dual strategy — Bolt API primary, webhook fallback. This is internal to `SlackNotifier`. The adapter tries Bolt first; if it fails or isn't configured, it falls back to the webhook URL. Core sees only the `Notifier` interface and doesn't know about fallbacks.

### FeedbackListener

Receives human feedback from external channels. Today: Slack thread replies. Tomorrow: GitHub PR review comments, web dashboard.

The adapter is responsible for transport-specific concerns only: receiving messages, parsing mode prefixes (`fix:`/`redo:`), filtering bot messages. All business logic — feedback round limits, 24h timeout, confirmation flow ("tak"/"nie"), killing active processes — lives in **core** (`Worker.enqueueFeedback` / `FeedbackCoordinator`). The adapter calls `replyFn` to communicate back to the user during the coordination flow.

```typescript
/** Raw feedback from an adapter — no business logic applied yet */
interface RawFeedback {
  taskKey: string;
  feedback: string;
  mode: "fix" | "redo";
  replyFn: (text: string) => Promise<void>;  // adapter provides this for core to reply
}

type RawFeedbackHandler = (raw: RawFeedback) => Promise<void>;

interface FeedbackListener {
  onFeedback(handler: RawFeedbackHandler): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

**Business logic flow**: Adapter receives message -> parses mode/text -> calls core handler with `RawFeedback` -> core checks round limits, 24h timeout, confirmation state -> core uses `replyFn` to ask for confirmation or report errors -> core dispatches to `TaskPipeline.handleFeedback` when approved.

### Store

Persists task state. Today: JSON file. Tomorrow: SQLite, PostgreSQL.

```typescript
interface Store {
  getTask(key: string): StoredTask | undefined;
  getTaskByThread(threadId: string): StoredTask | undefined;
  isProcessed(key: string): boolean;
  markProcessing(key: string): void;
  markDone(key: string, prUrl: string): void;
  markFailed(key: string, error: string): void;
  markReprocessing(key: string): void;
  resetTask(key: string): void;
  setThreadRef(key: string, ref: ThreadRef): void;
  setTaskInfo(key: string, info: TaskInfo): void;
  setChildPid(key: string, pid: number): void;
  clearChildPid(key: string): void;
  incrementFeedbackRound(key: string): number;
  setFeedbackClosed(key: string): void;
  setLimitReachedAt(key: string): void;
  resetFeedbackLimit(key: string): void;
  getStats(): { total: number; done: number; failed: number; processing: number };
}

interface StoredTask {
  key: string;
  startedAt: string;
  completedAt?: string;
  status: "processing" | "done" | "failed";
  prUrl?: string;
  error?: string;
  threadRef?: ThreadRef;      // generic — works for Slack, GitHub, etc.
  feedbackRound: number;
  feedbackClosed?: boolean;
  childProcessPid?: number;
  limitReachedAt?: string;
  taskInfo?: TaskInfo;
}
```

**Thread ref is generic**: `StoredTask.threadRef` uses the same `ThreadRef` type as `Notifier`. For the JSON store, `getTaskByThread(threadId)` searches `threadRef.id` across all tasks. The old `slackThreadTs`/`slackChannel` fields map to `threadRef.id`/`threadRef.channel`.

### VCS

Abstracts version control operations. Today: Git with worktrees.

```typescript
interface VCS {
  ensureReady(): void;
  branchName(key: string): string;
  branchExists(key: string): boolean;
  worktreePath(key: string): string;
  createWorktree(key: string): string;
  removeWorktree(key: string): void;
  closePR(key: string): void;   // used in redo mode to close existing PR before fresh start
}
```

## Core Classes

### TaskPipeline

Owns the orchestration logic for processing a task and handling feedback. Extracted from today's `processTask()` and `handleFeedback()` in `index.ts`. Depends only on port interfaces.

```typescript
class TaskPipeline {
  constructor(
    private ai: AIProvider,
    private taskSource: TaskSource,
    private notifier: Notifier,
    private store: Store,
    private vcs: VCS,
  ) {}

  async processTask(task: TaskInfo): Promise<void>;
  async handleFeedback(key: string, feedback: string, mode: "fix" | "redo"): Promise<void>;
}
```

### Worker

Owns lifecycle: polling loop, feedback queue, processing lock, graceful shutdown. Delegates task execution to `TaskPipeline`.

```typescript
class Worker {
  private processingLock = new Map<string, Promise<void>>();
  private feedbackQueue = new Map<string, { feedback: string; mode: "fix" | "redo" }>();

  constructor(
    private pipeline: TaskPipeline,
    private feedbackListener: FeedbackListener | null,
    private notifier: Notifier,
    private store: Store,
    private config: WorkerConfig,
  ) {}

  async start(once?: boolean): Promise<void>;
  async stop(): Promise<void>;
  private async pollCycle(): Promise<void>;
  private async enqueueFeedback(raw: RawFeedback): Promise<void>;  // owns round limits, 24h timeout, confirmation
  private async drainFeedbackQueue(): Promise<void>;
}
```

**`--once` mode**: `start(true)` runs a single poll cycle without starting the feedback listener or calling `notifyWorkerStart()`, matching current behavior.

## Composite Pattern for Multiple Adapters

When multiple adapters need to serve the same port simultaneously:

```typescript
class CompositeNotifier implements Notifier {
  constructor(private notifiers: Notifier[]) {}

  async notifyTaskStarted(task: TaskInfo) {
    const results = await Promise.all(
      this.notifiers.map(n => n.notifyTaskStarted(task))
    );
    return results.find(r => r !== undefined);
  }
  // ... same pattern for all methods
}

class CompositeFeedbackListener implements FeedbackListener {
  constructor(private listeners: FeedbackListener[]) {}

  onFeedback(handler: FeedbackHandler) {
    for (const listener of this.listeners) {
      listener.onFeedback(handler);
    }
  }
  // ...
}
```

These composites are NOT part of core — they live alongside the composition root or in a `support/` folder.

## Folder Structure

```
src/
  ports/
    ai-provider.ts
    task-source.ts
    notifier.ts
    feedback-listener.ts
    store.ts
    vcs.ts
    index.ts               — barrel export
  core/
    task-pipeline.ts
    worker.ts
    index.ts               — barrel export
  adapters/
    claude/
      claude-provider.ts   — AIProvider impl (spawn, stream-json, kill)
      prompts.ts           — prompt builders (buildPrompt, buildFeedbackPrompt, buildSystemPrompt)
    jira/
      jira-source.ts       — TaskSource impl
      jira-client.ts       — HTTP fetch wrapper with auth
      adf-parser.ts        — Atlassian Document Format to plain text
    slack/
      slack-notifier.ts    — Notifier impl
      slack-listener.ts    — FeedbackListener impl (message handler, round limits, 24h timeout)
      slack-client.ts      — Bolt app lifecycle, low-level postMessage/replyInThread/updateMessage
    git/
      git-vcs.ts           — VCS impl
    json-store/
      json-store.ts        — Store impl
  config/
    config.ts              — validated, typed config object
  logger.ts                — unchanged
  index.ts                 — composition root
```

## Migration Strategy

This is a pure refactor — no behavior changes. Each step produces working code:

1. Create port interfaces (new files, no changes to existing)
2. Create adapter files by extracting code from existing modules — each adapter implements its port
3. Create core classes by extracting from `index.ts`
4. Create composition root that wires everything
5. Delete old flat files
6. Verify all existing behavior preserved

## What Stays the Same

- Logger — works as-is, no coupling issues
- All business logic and behavior — zero changes
- JSON state file format — backward compatible
- Config env vars — same names, same defaults
- CLI interface (--once flag, same scripts)
