# ADR-003: Claude Code MAX Subscription, No API Key

**Date:** 2026-03-23
**Status:** Accepted
**Deciders:** Maciej Siara

## Context

Claude Code can run with either an API key (pay-per-token) or a MAX subscription (flat monthly rate). For an autonomous worker processing multiple JIRA tickets, API costs would be unpredictable and potentially high.

## Decision

Use MAX subscription exclusively. The worker:
- Sets `ANTHROPIC_API_KEY: undefined` in the spawned process env
- Warns at startup if `ANTHROPIC_API_KEY` is set
- Authenticates via `claude login` (one-time setup)

## Consequences

- Predictable monthly cost regardless of task volume
- Must have an active MAX subscription on the machine running the worker
- Cannot run in CI/CD or serverless without a logged-in session
