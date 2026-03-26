# Hexagonal Architecture Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor 9 flat files into ports & adapters architecture so integrations are swappable.

**Architecture:** Core pipeline depends only on port interfaces. Adapters implement ports for Slack, JIRA, Claude, Git, JSON store. Composition root wires them at startup.

**Tech Stack:** TypeScript 5.7+, Node.js, @slack/bolt, Claude Code CLI/ Cursor CLI

**Spec:** `docs/superpowers/specs/2026-03-23-hexagonal-refactor-design.md`

---

## File Map

### New files to create:

| File | Responsibility |
|------|---------------|
| `src/ports/types.ts` | Shared types: TaskInfo, ThreadRef, AIResult, FeedbackRequest, StoredTask |
| `src/ports/ai-provider.ts` | AIProvider interface |
| `src/ports/task-source.ts` | TaskSource interface |
| `src/ports/notifier.ts` | Notifier interface |
| `src/ports/feedback-listener.ts` | FeedbackListener + RawFeedback interface |
| `src/ports/store.ts` | Store interface |
| `src/ports/vcs.ts` | VCS interface |
| `src/ports/index.ts` | Barrel export |
| `src/adapters/claude/prompts.ts` | buildPrompt, buildFeedbackPrompt, buildSystemPrompt |
| `src/adapters/claude/claude-provider.ts` | AIProvider impl: spawn, stream-json, kill |
| `src/adapters/jira/jira-client.ts` | HTTP fetch wrapper with Basic auth |
| `src/adapters/jira/adf-parser.ts` | extractText from ADF |
| `src/adapters/jira/jira-source.ts` | TaskSource impl |
| `src/adapters/slack/slack-client.ts` | Bolt app lifecycle + low-level messaging |
| `src/adapters/slack/slack-notifier.ts` | Notifier impl (Bolt primary, webhook fallback) |
| `src/adapters/slack/slack-listener.ts` | FeedbackListener impl (transport only: parse mode, filter bots) |
| `src/adapters/git/git-vcs.ts` | VCS impl |
| `src/adapters/json-store/json-store.ts` | Store impl |
| `src/core/task-pipeline.ts` | Orchestration: processTask + handleFeedback |
| `src/core/worker.ts` | Lifecycle: poll loop, feedback coordination, queue, shutdown |
| `src/core/index.ts` | Barrel export |
| `src/config/config.ts` | Config (moved from src/config.ts) |

### Files to delete after migration:

| File | Replaced by |
|------|------------|
| `src/config.ts` | `src/config/config.ts` |
| `src/claude.ts` | `src/adapters/claude/claude-provider.ts` + `prompts.ts` |
| `src/jira.ts` | `src/adapters/jira/jira-source.ts` + `jira-client.ts` + `adf-parser.ts` |
| `src/slack.ts` | `src/adapters/slack/slack-notifier.ts` |
| `src/slack-bot.ts` | `src/adapters/slack/slack-listener.ts` + `slack-client.ts` |
| `src/store.ts` | `src/adapters/json-store/json-store.ts` |
| `src/git.ts` | `src/adapters/git/git-vcs.ts` |
| `src/index.ts` | `src/index.ts` (rewritten as composition root) |

### Files that stay unchanged:

| File | Reason |
|------|--------|
| `src/logger.ts` | No coupling issues (import path update only) |

---

## Task 1: Create port interfaces and shared types

All port interfaces and shared types. Pure type declarations — no implementation.

**Files:** Create `src/ports/types.ts`, `src/ports/ai-provider.ts`, `src/ports/task-source.ts`, `src/ports/notifier.ts`, `src/ports/feedback-listener.ts`, `src/ports/store.ts`, `src/ports/vcs.ts`, `src/ports/index.ts`

- [ ] **Step 1:** Create `src/ports/types.ts` with all shared types: `TaskInfo`, `ThreadRef`, `AIResult`, `FeedbackRequest`, `RawFeedback`, `StoredTask`, `WorkerConfig`
- [ ] **Step 2:** Create `src/ports/ai-provider.ts` — `AIProvider` interface with `run()`, `runWithFeedback()`, `kill()`
- [ ] **Step 3:** Create `src/ports/task-source.ts` — `TaskSource` interface with `poll()`, `transitionToInProgress()`, `transitionToReview()`, `addComment()`
- [ ] **Step 4:** Create `src/ports/notifier.ts` — `Notifier` interface with `notifyWorkerStart()`, `notifyTaskStarted()`, `notifyTaskStatus()`, `notifyTaskCompleted()`, `notifyTaskFailed()`, `replyInThread()`
- [ ] **Step 5:** Create `src/ports/feedback-listener.ts` — `FeedbackListener` interface with `onFeedback()`, `start()`, `stop()`
- [ ] **Step 6:** Create `src/ports/store.ts` — `Store` interface with all state operations
- [ ] **Step 7:** Create `src/ports/vcs.ts` — `VCS` interface with `ensureReady()`, `branchName()`, `branchExists()`, `worktreePath()`, `createWorktree()`, `removeWorktree()`, `closePR()`
- [ ] **Step 8:** Create `src/ports/index.ts` — barrel re-export all types and interfaces
- [ ] **Step 9:** Run `npx tsc --noEmit` — verify ports compile (existing files may error, that's expected)
- [ ] **Step 10:** Commit: `git add src/ports/ && git commit -m "refactor: add port interfaces for hexagonal architecture"`

Reference the spec document Section "Port Interfaces" for exact type definitions. Key details:
- `AIResult.pid?: number` — returned by adapter, core stores it via `Store.setChildPid()`
- `RawFeedback.replyFn` — adapter provides this callback so core can reply without knowing the transport
- `StoredTask.threadRef?: ThreadRef` — generic, not Slack-specific
- `Store.setThreadRef(key, ref: ThreadRef)` — replaces old `setSlackThread`

---

## Task 2: Create config module

Move config to its own directory. Exact same logic and env var names.

**Files:** Create `src/config/config.ts`

- [ ] **Step 1:** Copy `src/config.ts` to `src/config/config.ts` — no logic changes, same env vars. Default `CLAUDE_MAX_TURNS` is `"100"`.
- [ ] **Step 2:** Commit: `git add src/config/ && git commit -m "refactor: move config to src/config/"`

---

## Task 3: Create JSON Store adapter

Extract from `src/store.ts`. Implements `Store` port.

**Files:** Create `src/adapters/json-store/json-store.ts`

- [ ] **Step 1:** Create `JsonStore` class that implements `Store` interface. Constructor takes `filePath: string`. Internal storage uses `InternalTask` type (with `threadId`/`threadChannel` fields), mapped to `StoredTask` via `toStoredTask()` helper. All methods are direct port of existing `src/store.ts` functions as class methods. Key change: `setSlackThread` becomes `setThreadRef(key, ref: ThreadRef)` which stores `ref.id` as `threadId` and `ref.channel` as `threadChannel`. `getTaskByThread(threadId)` searches by `threadId` field.
- [ ] **Step 2:** Commit: `git add src/adapters/json-store/ && git commit -m "refactor: extract JsonStore adapter implementing Store port"`

---

## Task 4: Create Git VCS adapter

Extract from `src/git.ts`. Implements `VCS` port. Adds `closePR()` (extracted from `index.ts:175-182`).

**Files:** Create `src/adapters/git/git-vcs.ts`

- [ ] **Step 1:** Create `GitVCS` class that implements `VCS`. Constructor takes `{ path, baseBranch, remote }`. All functions from `src/git.ts` become methods. Add `closePR(key)` which runs `gh pr close <branch> --delete-branch`. The private `git()` helper uses `execSync` with the configured `path` as cwd.
- [ ] **Step 2:** Commit: `git add src/adapters/git/ && git commit -m "refactor: extract GitVCS adapter implementing VCS port"`

---

## Task 5: Create JIRA adapter

Extract from `src/jira.ts`. Three files: HTTP client, ADF parser, TaskSource impl.

**Files:** Create `src/adapters/jira/jira-client.ts`, `src/adapters/jira/adf-parser.ts`, `src/adapters/jira/jira-source.ts`

- [ ] **Step 1:** Create `JiraClient` class — HTTP wrapper extracted from `jiraFetch` + `authHeader`. Constructor takes `{ baseUrl, email, apiToken }`. Single method: `fetch<T>(path, options)`.
- [ ] **Step 2:** Create `adf-parser.ts` — export `extractText(adf)` function, exact copy from `src/jira.ts`.
- [ ] **Step 3:** Create `JiraSource` class implementing `TaskSource`. Constructor takes full JIRA config. Uses `JiraClient` and `extractText`. Key fix: log `data.issues?.length ?? 0` instead of `data.total` (was logging `undefined`).
- [ ] **Step 4:** Commit: `git add src/adapters/jira/ && git commit -m "refactor: extract JIRA adapter implementing TaskSource port"`

---

## Task 6: Create Slack adapters

Split `src/slack.ts` + `src/slack-bot.ts` into three focused files.

**Files:** Create `src/adapters/slack/slack-client.ts`, `src/adapters/slack/slack-notifier.ts`, `src/adapters/slack/slack-listener.ts`

- [ ] **Step 1:** Create `SlackClient` class — wraps Bolt `App` lifecycle + low-level messaging (`postMessage`, `replyInThread`, `updateMessage`, `sendWebhook`). Also exposes `onMessage(handler)` for registering message listeners. Includes diagnostics middleware that logs all incoming events. Both `SlackNotifier` and `SlackListener` share this client.
- [ ] **Step 2:** Create `SlackNotifier` class implementing `Notifier`. Uses `SlackClient`. Bolt primary, webhook fallback — same dual strategy as current `src/slack.ts` but encapsulated in one class. All Slack block formatting lives here.
- [ ] **Step 3:** Create `SlackListener` class implementing `FeedbackListener`. Transport-only responsibilities: filter bot messages, filter non-thread messages, parse `fix:`/`redo:` prefix, look up task via `Store.getTaskByThread()`, create `replyFn` bound to the thread, call `RawFeedbackHandler`. Business logic (round limits, 24h timeout, confirmation flow) is NOT here — it moved to `Worker.handleRawFeedback()`.
- [ ] **Step 4:** Commit: `git add src/adapters/slack/ && git commit -m "refactor: extract Slack adapters (client, notifier, listener)"`

---

## Task 7: Create Claude AI adapter

Extract from `src/claude.ts`. Split into prompts and provider.

**Files:** Create `src/adapters/claude/prompts.ts`, `src/adapters/claude/claude-provider.ts`

- [ ] **Step 1:** Create `prompts.ts` — export `buildPrompt(task, config)`, `buildSystemPrompt()`, `buildFeedbackPrompt(task, feedback, config)`, `buildFeedbackSystemPrompt(mode)`, and `ALLOWED_TOOLS` constant. Takes `{ baseBranch }` config instead of importing global config.
- [ ] **Step 2:** Create `ClaudeProvider` class implementing `AIProvider`. Constructor takes `{ maxTurns, timeoutMs, baseBranch }`. Contains `spawnClaude()`, `processStreamEvent()`, `extractResultText()`, `extractPrUrl()`. Key difference from current code: does NOT call `setChildPid`/`clearChildPid` — instead returns `pid` in `AIResult` so core manages it. Uses `stream-json` output format for real-time reasoning logs.
- [ ] **Step 3:** Commit: `git add src/adapters/claude/ && git commit -m "refactor: extract Claude adapter implementing AIProvider port"`

---

## Task 8: Create core — TaskPipeline and Worker

The heart of the refactor. Extract orchestration from `index.ts` and business logic from `slack-bot.ts`.

**Files:** Create `src/core/task-pipeline.ts`, `src/core/worker.ts`, `src/core/index.ts`

- [ ] **Step 1:** Create `TaskPipeline` class with `processTask(task)` and `handleFeedback(key, feedback, mode)`. Direct port of `processTask()` and `handleFeedback()` from `index.ts`. Dependencies: `AIProvider`, `TaskSource`, `Notifier`, `Store`, `VCS` — all via constructor injection. Uses `ThreadRef` instead of `slackChannel`/`slackThreadTs`. For feedback replies, uses `Notifier.replyInThread(threadRef, text)` with the stored `ThreadRef` from the task — NOT a `replyFn` callback. The fallback `TaskInfo` when `taskData.taskInfo` is undefined uses empty URL string (no config dependency). Uses `existsSync` from Node stdlib to check worktree existence in fix-vs-redo fallback (Node stdlib imports in core are acceptable).
- [ ] **Step 2:** Create `Worker` class with `start()`, `stop()`, `pollCycle()`, `handleRawFeedback(raw)`, `drainFeedbackQueue()`. Owns: processing lock, feedback queue, polling interval, graceful shutdown. Feedback coordination logic (round limits, 24h timeout, "tak"/"nie" confirmation, kill active process) moves here from `slack-bot.ts:handleMessage()` into `handleRawFeedback()`. This method uses `raw.replyFn` for the coordination flow (confirmations, limit messages). When dispatching to `TaskPipeline.handleFeedback(key, feedback, mode)`, the pipeline uses `Notifier.replyInThread()` with stored `ThreadRef` for status replies. Note: `prExists` from old `git.ts` is dead code (never called) — intentionally dropped.
- [ ] **Step 3:** Create `src/core/index.ts` barrel export.
- [ ] **Step 4:** Commit: `git add src/core/ && git commit -m "refactor: create core TaskPipeline and Worker classes"`

---

## Task 9: Create composition root and delete old files

Wire everything together. Delete old files.

**Files:** Rewrite `src/index.ts`, update `src/logger.ts` import, delete 7 old files.

- [ ] **Step 1:** Rewrite `src/index.ts` as composition root: create all adapters, wire to core, start worker. Includes prerequisite checks (claude --version, gh auth status). SlackClient is shared between SlackNotifier and SlackListener. SlackClient.start() is called before wiring core (only in continuous mode).
- [ ] **Step 2:** Update `src/logger.ts` — change `import { config } from "./config.js"` to `import { config } from "./config/config.js"`.
- [ ] **Step 3:** Delete old files: `rm src/config.ts src/claude.ts src/jira.ts src/slack.ts src/slack-bot.ts src/store.ts src/git.ts`
- [ ] **Step 4:** Run `npx tsc --noEmit` — must compile clean with zero errors.
- [ ] **Step 5:** Commit: `git add -A && git commit -m "refactor: complete hexagonal architecture migration"`

---

## Task 10: Smoke test

- [ ] **Step 1:** Run `npx tsx src/index.ts --once 2>&1 | head -20` — banner prints, poll cycle runs, "Done."
- [ ] **Step 2:** Run `npx tsc --noEmit` — clean compilation.
- [ ] **Step 3:** Verify dependency rule: `grep -r "from.*adapters" src/core/ src/ports/` — must return no matches. Core and ports must not import adapters.
- [ ] **Step 4:** Fix any issues found and commit.
