# ADR 0012 — First-registration-wins provider dedup, silent + verbose-logged

- **Status**: Accepted
- **Date**: 2026-07-02
- **Scope**: `packages/core` (`container/container.ts`)
- **Relation**: depends on [ADR 0009](./0009-module-loading-two-phases.md) (a module's full provider set must be known before registration starts).

## Context

A module can `export` a token it imported from elsewhere, and multiple modules in the graph can import the same shared module. Each importer's container ends up calling `add()` for the same re-exported token — this is the **normal, expected** shape of the module graph, not a mistake. `Container.add()` needs a policy for what happens when a token is registered twice in the same container.

The competing concern: an _unintended_ override — e.g. two different providers accidentally declared under the same token due to a typo or a misconfigured import — should still be discoverable somehow, even though it must not be as loud as a hard error (since legitimate duplicate registration happens constantly).

## Decision

```ts
add(provider: Provider): void {
  const token = provider.provide;
  const key = tokenKey(token);

  if (this.providers.has(key)) {
    this.logger.verbose(
      `Provider ${stringifyToken(token)} already registered, ignored.`,
      this.logContext
    );
    return;
  }

  this.providers.set(key, provider);
  ...
}
```

**First registration of a token wins.** A later `add()` call for an already-registered key is silently dropped — no error, no warning-level log — but is still recorded at `verbose` log level, so an unintended override remains traceable by someone actively debugging a "wrong provider resolved" symptom, without spamming normal operation (where every shared exported token is legitimately re-added by every importer).

This policy is load-bearing for the module system: [ADR 0009](./0009-module-loading-two-phases.md)'s two-phase loading exists specifically so that, by the time any `add()` call happens, a module's full provider set (including every `DynamicModule` occurrence's extra providers) is already known — first-wins is only safe because registration order no longer depends on unrelated import-graph traversal order.

## Alternatives considered

### Throw on duplicate registration

Rejected: would make the normal "shared token re-exported through multiple import paths" case a hard failure, forcing every module to special-case detecting "is this token already provided by an ancestor" before declaring its own imports/exports — defeating the point of a declarative module graph.

### Silently overwrite (last registration wins) instead of first-wins

Rejected: makes the _order_ modules happen to be visited in during graph traversal significant for which provider ends up registered — a subtle, hard-to-predict dependency on import ordering. First-wins ties the winning provider to the module graph's declared structure (whichever branch registers a token first, deterministically, given [ADR 0009](./0009-module-loading-two-phases.md)'s ordering), not to incidental traversal order downstream of it.

### Warn-level (not verbose-level) log on every duplicate

Rejected: duplicates are the common case (every re-export of a shared token by every importer), so a warn-level log on each one would drown out genuinely actionable warnings in normal operation.

## Consequences

- **Positive**: the "export a shared token, multiple modules import it" pattern works with zero special-casing from module authors.
- **Positive**: an accidental override stays traceable — enabling `verbose` logging surfaces every dropped registration with its token name.
- **Negative / Caution**: an unintended override (typo'd token colliding with an existing one, or a misconfigured provider list) fails **silently** at default log levels — the app keeps running with the first-registered (possibly wrong) provider, and nothing surfaces unless `verbose` logging is explicitly enabled to investigate.
