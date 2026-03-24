---
name: clean-code-standards
description: Enforces hexagonal architecture, SOLID, DRY, clean code, and project conventions during all development and planning work
---

# Clean Code Standards — jira-ai-worker

You MUST follow these rules when writing, modifying, or planning code in this project. These are non-negotiable.

## 1. Hexagonal Architecture

- **Core** (`src/core/`) imports ONLY from `src/ports/` and `src/constants.ts` and `src/utils/`
- **Adapters** (`src/adapters/`) import from `src/ports/`, `src/constants.ts`, `src/utils/`, and `src/logger.ts` — NEVER from `src/core/` and NEVER from other adapters
- **Ports** (`src/ports/`) contain ONLY interfaces and types — zero implementation
- **Composition root** (`src/index.ts`) is the ONLY file that imports from both core and adapters
- Shared constants/utilities go in `src/constants.ts` or `src/utils/` — accessible to all layers without violating boundaries
- Business logic belongs in core, transport/formatting logic belongs in adapters

## 2. SOLID Principles

### Single Responsibility

- No class should have more than 3 clear responsibilities
- Methods over 50 lines are a code smell — extract helpers
- If a class constructor takes more than 5-6 dependencies, it's doing too much — extract collaborator classes
- Use the patterns already in place: `FeedbackCommandHandler`, `ProcessingLockManager` are examples of proper extraction

### Open/Closed

- Prefer strategy maps or registries over if/else chains when handling extensible categories (commands, event types)
- New behavior should be addable without modifying existing code where practical

### Liskov Substitution

- All adapters must fully implement their port interface — no partial implementations
- Return types and error behavior must be consistent with the interface contract

### Interface Segregation

- The `Store` interface is split into `TaskQueryStore`, `TaskStateStore`, `FeedbackStore`, `TaskMetadataStore`
- When adding new store methods, put them in the correct sub-interface
- Consumers should depend on the narrowest sub-interface they need (though `Store` composite is fine for composition root wiring)

### Dependency Inversion

- Core depends on port interfaces, never on concrete adapter classes
- Adapters receive dependencies through constructor injection
- Never import global config directly in adapters — pass config through constructor

## 3. DRY Rules

- Before writing ANY code, check if a similar pattern already exists:
  - `src/utils/errors.ts` — `toErrorMessage()` for error extraction
  - `src/core/task-pipeline.ts` — `createProgressCallback()` for throttled Slack progress
  - `src/core/task-pipeline.ts` — `handleAIResult()` for unified PR validation + result recording
  - `src/core/processing-lock-manager.ts` — `withLock()` for lock-execute-release
  - `src/adapters/slack/slack-ui.ts` — `buildActionButtons()`, `STATUS_EMOJI`
  - `src/adapters/slack/slack-notifier.ts` — `sendViaAvailableChannel()` for Bolt/webhook fallback
- If you write the same pattern twice, extract it immediately
- If a value appears as a literal in more than one place, it belongs in `src/constants.ts`

## 4. Constants & Magic Numbers

- ALL numeric constants go in `src/constants.ts` with descriptive names
- ALL string command names go in `src/constants.ts` as const arrays
- Status values use the `TaskStatus` type from `src/constants.ts`
- Status emoji use the `STATUS_EMOJI` map from `src/constants.ts`
- `parseInt()` always includes radix: `parseInt(value, 10)`
- Never hardcode timeouts, intervals, limits, or display counts inline

## 5. Type Safety

- No `any` where avoidable
- Slack payloads: use types from `src/adapters/slack/slack-types.ts` (`SlackActionPayload`, `SlackViewSubmissionPayload`, `SlackMessageEvent`)
- Claude stream events: use types from `src/adapters/claude/stream-types.ts` (`ClaudeStreamEvent`, `ContentBlock`)
- Button blocks: use `SlackButton` type from `src/adapters/slack/slack-ui.ts`
- When `any` is unavoidable (SDK boundaries), cast to a local typed interface rather than using `any` throughout
- Use discriminated unions for event types (see `ClaudeStreamEvent`)

## 6. Error Handling

- Always use `toErrorMessage(err)` from `src/utils/errors.ts` — never write `err instanceof Error ? err.message : String(err)` inline
- Adapters: catch and log, don't throw upward unless the error is unrecoverable
- Core: catch at orchestration boundaries, mark tasks as failed, notify user
- Never silently swallow errors without at least a `log.debug` or `log.warn`

## 7. Code Organization

- Each new core responsibility gets its own file (see `feedback-command-handler.ts`, `processing-lock-manager.ts`)
- Adapter shared utilities go in a `<adapter-name>-ui.ts` or `<adapter-name>-types.ts` file within the adapter directory
- Barrel exports (`index.ts`) only needed for ports and core — not adapters (only composition root imports them)

## 8. Naming

- Constants: `UPPER_SNAKE_CASE`
- Types/Interfaces: `PascalCase`
- Methods/variables: `camelCase`
- Files: `kebab-case.ts`
- Port interfaces: noun describing capability (`Store`, `Notifier`, `VCS`, `AIProvider`)
- Adapter classes: `<Tech><Port>` pattern (`JsonStore`, `SlackNotifier`, `GitVCS`, `ClaudeProvider`)

## 9. Before Submitting Any Code

Run through this checklist:

- [ ] No adapter imports core, no adapter imports another adapter
- [ ] No magic numbers/strings — all in `src/constants.ts`
- [ ] No `any` without justification
- [ ] No duplicated logic — reuse existing helpers
- [ ] Methods under 50 lines
- [ ] Classes under 5-6 constructor dependencies
- [ ] `toErrorMessage()` used for all error extraction
- [ ] `npx tsc --noEmit` passes
