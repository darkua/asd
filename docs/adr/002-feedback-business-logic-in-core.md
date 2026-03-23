# ADR-002: Feedback Business Logic Lives in Core, Not Adapters

**Date:** 2026-03-23
**Status:** Accepted
**Deciders:** Maciej Siara

## Context

The Slack bot handler (`slack-bot.ts`) contained significant business logic: feedback round limits, 24h timeout, "tak"/"nie" confirmation flow, killing active AI processes, and queue management. This logic was tightly coupled to Slack's message format.

When adding GitHub PR review comments or a web dashboard as feedback sources, this logic would need to be duplicated.

## Decision

Split feedback handling into two layers:

**Adapter (transport only):** Receives messages, filters bots/non-threads, parses `fix:`/`redo:` prefix, provides a `replyFn` callback. No business logic.

**Core (`Worker.handleRawFeedback`):** Owns all business logic — round limits, 24h timeout, confirmation flow, process killing, queue management. Uses `replyFn` to communicate back without knowing the transport.

The adapter sends `RawFeedback { taskKey, feedback, mode, replyFn }` to core.

## Consequences

- Any new feedback source (GitHub, web dashboard) only needs to parse its transport format and provide a `replyFn`
- Round limits, timeouts, and confirmation are consistent across all channels
- Core can be tested without Slack
