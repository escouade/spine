# ADR 0010 — Atomic module lifecycle: `onInit` → `onStart` → `onStop`, reverse-order teardown

- **Status**: Accepted
- **Date**: 2026-07-02
- **Scope**: `packages/core` (`app.ts`, `module/module.ts`, `module/module-loader.ts`)
- **Relation**: builds on [ADR 0009](./0009-module-loading-two-phases.md) (module graph resolution); [ADR 0013](./0013-shutdown-timeout-hard-kill.md) covers the process-level shutdown wrapper around `stop()`.

## Context

A module can optionally implement `OnInit`, `OnStart`, `OnStop` (detected by method presence, no base class required). Three separate hooks exist because they answer different questions:

- `onInit()` — "set myself up, my imports are ready" (can depend on already-initialized imports).
- `onStart()` — "begin doing work" (can assume the **entire** graph is initialized, not just direct imports — e.g. safe to reach across the graph via an injected cross-module service).
- `onStop()` — "tear myself down."

The open questions this decision resolves: in what order do these run, and what happens when one throws partway through boot.

## Decision

### 1. `onInit` runs during module resolution, deps before dependents

`ModuleLoader.buildAndInitModule()` awaits all of a module's imports (built + `onInit`ed) before building and `onInit`ing the module itself — so a module's `onInit()` can always assume its declared imports are already initialized.

### 2. `onStart` runs after the whole graph is initialized, in init order

```ts
public async start(): Promise<void> {
  if (this.stopped) throw new Error("Cannot start a stopped App");
  if (this.started) return;
  this.started = true;
  for (const ref of this.loader.modules.values()) {
    if (hasOnStart(ref.instance)) await ref.instance.onStart();
  }
  ...
}
```

Deferred to a separate pass (not folded into `onInit`) so a module's `onStart()` can rely on **any** module in the graph being ready, not just its direct imports — e.g. a module that reaches another one indirectly through a shared exported service.

### 3. `onStop` runs in reverse init order, paired with `onInit` (not `onStart`)

```ts
public async stop(): Promise<void> {
  if (this.stopped) return;
  this.stopped = true;
  for (const ref of [...this.loader.modules.values()].reverse()) {
    if (hasOnStop(ref.instance)) await ref.instance.onStop();
  }
  this.detachProcessHandlers();
}
```

Dependents stop before their dependencies, mirroring the init order in reverse — a module's `onStop()` can still safely use its imports while cleaning up. `onStop` is guaranteed for every module that reached the registry (i.e. completed `onInit()`), **regardless of whether its `onStart()` ran or even exists** — the pairing is with `onInit`, not `onStart`.

### 4. Atomic boot: any failure triggers a full `stop()`

```ts
async init() {
  try {
    await this.loader.load();
  } catch (e) {
    await this.stop();
    throw e;
  }
}
```

```ts
public async start(): Promise<void> {
  ...
  try {
    for (const ref of this.loader.modules.values()) { ... }
  } catch (e) {
    await this.stop();
    throw e;
  }
}
```

A module that fails its own `onInit()` never enters `loader.modules` (see [ADR 0009](./0009-module-loading-two-phases.md) — the registry is filled incrementally during resolution, so it holds exactly the partial set that DID succeed even if resolution as a whole throws). `stop()` then tears down every module that DID reach the registry, in reverse order — so a partial boot never leaves some modules running while others failed. The same logic applies to a failed `onStart()`: it doesn't leave earlier-started modules running, because `stop()` still runs `onStop()` on everything that was `onInit`ed, whether or not its own `onStart()` had already fired.

## Alternatives considered

### Fold `onStart` into `onInit` (single lifecycle hook)

Rejected: an `onInit()` running as part of module resolution can only assume its own imports are ready — not the whole graph. Work that needs the full graph (e.g. cross-cutting startup tasks that reach services outside direct imports) would have no safe hook to run from.

### Pair `onStop` with `onStart` instead of `onInit`

Rejected: would leave modules that succeeded `onInit()` but never got a chance to `onStart()` (because a sibling's `onStart()` failed first) without cleanup — resources acquired in `onInit()` would leak on a failed boot.

### Partial rollback (only tear down the failing branch, keep healthy modules running)

Rejected: much more complex (would require reference-counting cross-module dependencies to know what's still safe to keep alive) for a benefit — partially running app state after a failed boot — that isn't needed; a failed boot should not leave the app half-running.

## Consequences

- **Positive**: strong invariant — either every reachable module is initialized/started, or the app is fully torn down; no partially-booted state to reason about downstream.
- **Positive**: `onStart()` can safely reach across the whole graph, not just direct imports.
- **Positive**: `onStop()` cleanup is guaranteed for any module that got as far as `onInit()`, independent of `onStart()` outcome.
- **Negative**: a single failing module's `onStart()` aborts the entire app, even if the failure is local and other modules' `onStart()` work was otherwise fine — no per-module restart or partial-start recovery.
