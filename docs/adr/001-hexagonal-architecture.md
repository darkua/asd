# ADR-001: Hexagonal Architecture (Ports & Adapters)

**Date:** 2026-03-23
**Status:** Accepted
**Deciders:** Maciej Siara

## Context

The worker started as 9 flat files with tight coupling. Every module imported directly from every other. `index.ts` was a 13KB god file owning orchestration, feedback, queue, and lifecycle.

The roadmap includes: GitHub integration, multiple repos, different AI backends, and a web dashboard. Each would require touching core business logic.

## Decision

Adopt Hexagonal Architecture (Ports & Adapters):

- **Ports** (`src/ports/`) — interfaces defining what core needs
- **Adapters** (`src/adapters/`) — implementations for specific technologies
- **Core** (`src/core/`) — business logic depending only on ports
- **Composition root** (`src/index.ts`) — wires adapters to core at startup

Six ports: `AIProvider`, `TaskSource`, `Notifier`, `FeedbackListener`, `Store`, `VCS`.

## Alternatives Considered

**Layered (Service/Repository):** Familiar but boundaries blur over time. Services grow into god classes. Swapping integrations requires touching service code.

**Minimal cleanup (keep flat, extract interfaces):** Least effort but doesn't solve coupling. Every future integration would force a larger rewrite.

## Consequences

**Positive:**
- Adding GitHub = write adapter, plug into composite, zero core changes
- Swapping AI backend = new `AIProvider` adapter
- Core is testable without external dependencies
- Clear ownership: adapters own transport, core owns business logic

**Negative:**
- More files (22 source files vs 9)
- Slight indirection when tracing calls
- New developers need to understand the port/adapter pattern

**Neutral:**
- JSON store stays behind interface — DB migration is a new adapter, not a rewrite
- Composite pattern enables multiple simultaneous adapters per port
