# CLAUDE.md — jira-ai-worker

## Project

JIRA AI Worker — polls JIRA for `AI-GEN` tickets, spawns Claude Code CLI to implement them, creates draft PRs, notifies Slack with real-time progress. Uses Claude Code MAX subscription (no API key).

## Architecture

Hexagonal (Ports & Adapters). Three layers:

- **Ports** (`src/ports/`) — interfaces only, no implementation
- **Adapters** (`src/adapters/`) — implementations: claude, jira, slack, git, json-store, health
- **Core** (`src/core/`) — business logic depending only on ports

**Dependency rule**: Core imports ports. Adapters import ports. Core never imports adapters. Adapters never import each other. Only `src/index.ts` (composition root) imports everything.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Composition root — wires adapters to core |
| `src/core/task-pipeline.ts` | Orchestration: processTask + handleFeedback, PR validation |
| `src/core/worker.ts` | Lifecycle: poll loop, feedback queue, commands (cancel/retry/reopen/status), crash recovery, worktree cleanup |
| `src/adapters/claude/claude-provider.ts` | Spawns Claude CLI, streams JSON, logs reasoning, progress callbacks, sanitized env |
| `src/adapters/claude/prompts.ts` | System prompts + implementation instructions |
| `src/adapters/slack/slack-listener.ts` | Receives Slack thread replies as feedback + status command |
| `src/adapters/slack/slack-notifier.ts` | Notifications with cost tracking + progress updates |
| `src/adapters/health/health-server.ts` | HTTP health check endpoint |
| `src/config/config.ts` | All env vars, validated at startup |

## Tech Stack

- TypeScript 5.7+ (strict, ESM with `.js` extensions in imports)
- Node.js 22+
- `@slack/bolt` for Slack Socket Mode
- `dotenv` for env loading
- No test framework yet

## Conventions

- **ESM imports** — always use `.js` extension: `import { X } from "./foo.js"`
- **No `any`** where avoidable — use proper types from `src/ports/types.ts`
- **Classes for adapters** — each adapter is a class implementing a port interface
- **createLogger(jiraKey?)** — use for all logging, pass JIRA key for contextual logs
- **Config via constructor** — adapters receive config through constructor, never import global config
- **Port types** — shared types live in `src/ports/types.ts`: `TaskInfo`, `ThreadRef`, `AIResult`, `StoredTask`, `ProgressEvent`, `WorkerConfig`, `WorkerStatus`
- **Atomic state writes** — JsonStore uses write-to-tmp-then-rename for crash safety
- **Environment sanitization** — Claude child process gets only allowlisted env vars (no secrets)

## Adding a New Adapter

1. Create interface in `src/ports/` if new port needed
2. Create adapter in `src/adapters/<name>/` implementing the port
3. Wire in `src/index.ts` composition root
4. For multiple adapters on same port, use Composite pattern (see spec)

## Common Tasks

**Adding an env var**: Add to `src/config/config.ts` with `required()` or `optional()`.

**Changing AI prompt**: Edit `src/adapters/claude/prompts.ts`.

**Adding a notification channel**: Create new `Notifier` implementation, wrap with existing in `CompositeNotifier`.

**Modifying feedback flow**: Business logic (round limits, timeouts, commands) is in `src/core/worker.ts`. Transport parsing is in the adapter.

**Adding a Slack command**: Add case in `Worker.handleRawFeedback()` for thread commands, or in `SlackListener.handleMessage()` for channel commands.

## Slack Interaction Model

**Button-driven**: All task interactions happen through Slack buttons, not text commands. Thread text is ignored (except bot mention and "status" which re-post buttons).

### Interactive Buttons (appear in task thread after completion/failure)

| Button | Action |
|--------|--------|
| 🔧 Fix | Opens modal to type targeted feedback |
| 🔄 Redo | Opens modal to type feedback for fresh implementation |
| 📊 Status | Shows task info + re-posts buttons |
| 🔁 Retry | Resets failed task for reprocessing (failed tasks only) |
| 🛑 Cancel | Kills running task immediately |

During processing: all buttons replaced with Cancel-only. Full buttons re-appear when agent finishes.

### Channel-level triggers

| Trigger | Action |
|---------|--------|
| `@bot` mention | Shows task list with Open buttons per task |
| `status` text | Same as mention — shows task list |

Clicking **Open** on a task creates new message with task info + action buttons in thread.

### Thread-level triggers

| Trigger | Action |
|---------|--------|
| `@bot` mention | Shows task status + re-posts action buttons |
| `status` text | Same as mention |

### Task Status Flow

```
processing → review (PR created, awaiting human review)
           → failed
review → processing (feedback applied via Fix/Redo)
failed → processing (via Retry button)
```

Main Slack message shows: `👀 Under Review` (not "Done") after PR creation.

## What NOT to Do

- Do not import from `src/adapters/` in `src/core/` or `src/ports/`
- Do not put business logic in adapters (adapters are transport only)
- Do not use `ANTHROPIC_API_KEY` — this uses MAX subscription
- Do not auto-merge PRs — always create as drafts
- Do not pass secrets to Claude child process — use `buildSafeEnv()` allowlist
