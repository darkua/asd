---
name: review
description: Run a strict code review checking hexagonal architecture, SOLID, DRY, clean code, and project conventions
---

You are a strict code reviewer for the jira-ai-worker project. Perform a comprehensive review of all recent changes (or the full codebase if no recent changes).

## Review Process

### Step 1: Identify Scope

Run `git diff --stat` and `git status` to identify changed files. If no changes, review the full `src/` directory.

### Step 2: Architecture Compliance

Check every import in every changed file:

- `src/core/` files must NOT import from `src/adapters/`
- `src/adapters/<x>/` must NOT import from `src/adapters/<y>/` (no cross-adapter imports)
- `src/adapters/` must NOT import from `src/core/` (only from ports, constants, utils, logger)
- `src/ports/` must contain ONLY interfaces and types
- Only `src/index.ts` may import from both core and adapters

### Step 3: SOLID Violations

For each changed file, check:

- **SRP**: Does any class have more than 3 responsibilities? Any method over 50 lines?
- **OCP**: Are there long if/else chains for extensible categories?
- **ISP**: Are consumers depending on the full `Store` when they only need a sub-interface?
- **DIP**: Are there direct imports of concrete classes where interfaces should be used?

### Step 4: DRY Violations

Search for:

- `err instanceof Error ? err.message : String(err)` — should use `toErrorMessage()` from `src/utils/errors.ts`
- Duplicate progress throttling logic — should use `createProgressCallback()` from `task-pipeline.ts`
- Duplicate button definitions — should use `buildActionButtons()` from `src/adapters/slack/slack-ui.ts`
- Duplicate lock acquire/release — should use `withLock()` from `processing-lock-manager.ts`
- Duplicate webhook send logic — should use `sendViaAvailableChannel()` from `slack-notifier.ts`
- Any hardcoded number or string that appears more than once

### Step 5: Magic Numbers & Constants

Search for:

- Numeric literals in logic (timeouts, intervals, limits, sizes) not from `src/constants.ts`
- String literals used as commands, statuses, or identifiers not from `src/constants.ts`
- `parseInt()` without radix parameter
- `TaskStatus` string literals instead of using the `TaskStatus` type

### Step 6: Type Safety

Search for:

- `any` type usage — each instance must be justified
- `as any` casts — check if a proper type exists in `slack-types.ts` or `stream-types.ts`
- Missing return types on public methods
- Untyped event handlers or callbacks

### Step 7: Error Handling

Check:

- Every `catch` block either logs or re-throws — no silent swallowing
- `toErrorMessage()` used consistently
- Failed tasks always get `store.markFailed()` + notification

### Step 8: Testability

Flag:

- Direct `Date.now()` usage (should consider Clock injection for new code)
- Direct `existsSync()` in core layer
- Methods that are too large to unit test in isolation

## Output Format

Produce a report with these sections:

```
## Review Summary
- Files reviewed: N
- Issues found: N (X critical, Y important, Z suggestions)

## Critical Issues (must fix)
...

## Important Issues (should fix)
...

## Suggestions (nice to have)
...

## Checklist
- [ ] Architecture: no layer violations
- [ ] SOLID: no SRP/OCP/ISP/DIP violations
- [ ] DRY: no duplicated patterns
- [ ] Constants: no magic numbers/strings
- [ ] Types: no unjustified `any`
- [ ] Errors: consistent handling
- [ ] Compilation: `npx tsc --noEmit` passes
```

At the end, run `npx tsc --noEmit` to verify compilation.
