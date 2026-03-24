# CLAUDE.md — jira-ai-worker

## Project

JIRA AI Worker — polls JIRA for `AI-GEN` tickets, spawns Claude Code CLI to implement them, creates draft PRs, notifies Slack with real-time progress. Uses Claude Code MAX subscription (no API key).

## Code Quality Enforcement

**MANDATORY**: All development and planning work must follow the clean code standards defined in `.claude/skills/clean-code-standards.md`. This skill covers hexagonal architecture rules, SOLID principles, DRY patterns, constants policy, type safety requirements, and error handling conventions.

**After completing any implementation work**, run `/review` to trigger a strict code review that checks architecture compliance, SOLID violations, DRY violations, magic numbers, type safety, and error handling.

## Architecture

Hexagonal (Ports & Adapters). Three layers:

- **Ports** (`src/ports/`) — interfaces only, no implementation
- **Adapters** (`src/adapters/`) — implementations: claude, jira, slack, git, json-store, health
- **Core** (`src/core/`) — business logic depending only on ports

**Dependency rule**: Core imports ports. Adapters import ports. Core never imports adapters. Adapters never import each other. Only `src/index.ts` (composition root) imports everything.

**Shared infrastructure** (`src/constants.ts`, `src/utils/`, `src/logger.ts`) — accessible from all layers without violating boundaries.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Composition root — wires adapters to core |
| `src/constants.ts` | All magic numbers, strings, status types, emoji maps |
| `src/utils/errors.ts` | `toErrorMessage()` — use for ALL error extraction |
| `src/core/worker.ts` | Thin orchestrator: poll loop, delegates to FeedbackCommandHandler + ProcessingLockManager |
| `src/core/task-pipeline.ts` | Orchestration: processTask + handleFeedback + handleAIResult (unified PR validation) |
| `src/core/feedback-command-handler.ts` | Command parsing (cancel/retry/reopen/status) + round limit state machine |
| `src/core/processing-lock-manager.ts` | Per-task locking with `withLock()` + iterative queue drain |
| `src/adapters/claude/claude-provider.ts` | Spawns Claude CLI, streams JSON, progress callbacks, sanitized env |
| `src/adapters/claude/stream-types.ts` | Typed Claude CLI stream events (`ClaudeStreamEvent`, `ContentBlock`) |
| `src/adapters/claude/prompts.ts` | System prompts + implementation instructions |
| `src/adapters/slack/slack-listener.ts` | Receives Slack button actions + status triggers |
| `src/adapters/slack/slack-notifier.ts` | Notifications with Bolt/webhook fallback via `sendViaAvailableChannel()` |
| `src/adapters/slack/slack-ui.ts` | Shared `buildActionButtons()`, `STATUS_EMOJI` |
| `src/adapters/slack/slack-types.ts` | Typed Slack payloads (`SlackActionPayload`, `SlackMessageEvent`) |
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
- **No `any`** where avoidable — use typed interfaces from `slack-types.ts`, `stream-types.ts`
- **No magic numbers** — all go in `src/constants.ts` with descriptive names
- **No inline error extraction** — always use `toErrorMessage()` from `src/utils/errors.ts`
- **Classes for adapters** — each adapter is a class implementing a port interface
- **createLogger(jiraKey?)** — use for all logging, pass JIRA key for contextual logs
- **Config via constructor** — adapters receive config through constructor, never import global config
- **Port types** — shared types in `src/ports/types.ts`: `TaskInfo`, `ThreadRef`, `AIResult`, `StoredTask`, `TaskStatus`, etc.
- **Store sub-interfaces** — `TaskQueryStore`, `TaskStateStore`, `FeedbackStore`, `TaskMetadataStore` (use narrowest needed)
- **Atomic state writes** — JsonStore uses write-to-tmp-then-rename + in-memory cache
- **Environment sanitization** — Claude child process gets only allowlisted env vars (no secrets)
- **parseInt always with radix** — `parseInt(value, 10)`

## Reusable Patterns (check before writing new code)

| Pattern | Location | Use When |
|---------|----------|----------|
| `toErrorMessage(err)` | `src/utils/errors.ts` | Extracting message from unknown error |
| `createProgressCallback(thread)` | `src/core/task-pipeline.ts` | Throttled Slack progress notifications |
| `handleAIResult(result, key, ...)` | `src/core/task-pipeline.ts` | PR validation + store/JIRA/Slack update |
| `withLock(key, fn)` | `src/core/processing-lock-manager.ts` | Per-task lock-execute-release |
| `buildActionButtons(key, status)` | `src/adapters/slack/slack-ui.ts` | Slack action button blocks |
| `STATUS_EMOJI` | `src/constants.ts` | Status-to-emoji mapping |
| `sendViaAvailableChannel(blocks, text)` | `src/adapters/slack/slack-notifier.ts` | Bolt or webhook fallback |

## Adding a New Adapter

1. Create interface in `src/ports/` if new port needed
2. Create adapter in `src/adapters/<name>/` implementing the port
3. Wire in `src/index.ts` composition root
4. For multiple adapters on same port, use Composite pattern

## Common Tasks

**Adding an env var**: Add to `src/config/config.ts` with `required()` or `optional()`. Always `parseInt(value, 10)` for numbers.

**Changing AI prompt**: Edit `src/adapters/claude/prompts.ts`.

**Adding a notification channel**: Create new `Notifier` implementation, wrap with existing in `CompositeNotifier`.

**Modifying feedback flow**: Commands/round limits in `src/core/feedback-command-handler.ts`. Queue/lock logic in `src/core/processing-lock-manager.ts`. Transport parsing in the Slack adapter.

**Adding a Slack command**: Add handler method in `FeedbackCommandHandler` + register in its `handle()` method.

**Adding a constant**: Add to `src/constants.ts` in the appropriate section.

## Slack Interaction Model

**Button-driven**: All task interactions happen through Slack buttons, not text commands. Thread text is ignored (except bot mention and "status" which re-post buttons).

### Interactive Buttons (appear in task thread after completion/failure)

| Button | Action |
|--------|--------|
| Fix | Opens modal to type targeted feedback |
| Redo | Opens modal to type feedback for fresh implementation |
| Status | Shows task info + re-posts buttons |
| Retry | Resets failed task for reprocessing (failed tasks only) |
| Cancel | Kills running task immediately |

During processing: all buttons replaced with Cancel-only. Full buttons re-appear when agent finishes.

### Channel-level triggers

| Trigger | Action |
|---------|--------|
| `@bot` mention | Shows task list with Open buttons per task |
| `status` text | Same as mention — shows task list |

### Task Status Flow

```
processing -> review (PR created, awaiting human review)
           -> failed
review -> processing (feedback applied via Fix/Redo)
failed -> processing (via Retry button)
```

## What NOT to Do

- Do not import from `src/adapters/` in `src/core/` or `src/ports/`
- Do not import from one adapter in another adapter
- Do not put business logic in adapters (adapters are transport only)
- Do not use `ANTHROPIC_API_KEY` — this uses MAX subscription
- Do not auto-merge PRs — always create as drafts
- Do not pass secrets to Claude child process — use `buildSafeEnv()` allowlist
- Do not use `any` without justification — use typed interfaces
- Do not hardcode numbers/strings — put them in `src/constants.ts`
- Do not write `err instanceof Error ? err.message : String(err)` — use `toErrorMessage()`
- Do not duplicate existing patterns — check the Reusable Patterns table first
