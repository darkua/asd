# ADR-004: Git Worktrees for Task Isolation

**Date:** 2026-03-23
**Status:** Accepted
**Deciders:** Maciej Siara

## Context

Claude Code needs a clean working directory per task. Options: clone per task, branch switching, or worktrees.

## Decision

Use git worktrees. Each task gets `<repo-parent>/.worktrees/<key>` with a dedicated branch `feat/<key>`.

## Alternatives Considered

**Clone per task:** Safe but slow (full clone) and disk-heavy.

**Branch switching:** Fast but not concurrent-safe. One task's uncommitted changes could leak to another.

## Consequences

- Fast creation (seconds, not minutes)
- Full isolation — each task has its own working directory
- Worktrees are kept after completion for inspection
- Requires git 2.5+ (worktree support)
- Stale worktrees need periodic cleanup (`git worktree prune`)
