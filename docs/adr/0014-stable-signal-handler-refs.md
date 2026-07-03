# ADR 0014 — Stable process-signal handler references for clean detachment

- **Status**: Accepted
- **Date**: 2026-07-02
- **Scope**: `packages/core` (`app.ts`)
- **Relation**: paired with [ADR 0010](./0010-atomic-module-lifecycle.md)'s `stop()` (where detachment happens).

## Context

`App`'s constructor installs process-level listeners for `uncaughtException`, `unhandledRejection`, `SIGINT` and `SIGTERM`, so the app can log and exit gracefully on these events. Multiple `App` instances can exist over a process's lifetime — most commonly in tests, and on Electron main-process reloads during development — and each one installs its own set of listeners.

`process.removeListener(event, fn)` only removes a listener if `fn` is the **exact same function reference** that was passed to `process.on()`. If the handler were registered as an inline closure (`process.on("SIGINT", () => this.exitHandler())`), there would be no way to later target that specific listener for removal — `removeListener` requires the reference, and an anonymous closure created inline is never referenced again anywhere else. Without a way to detach, every `App` instance's listeners would stack indefinitely, eventually triggering Node's `MaxListenersExceededWarning`, and old, already-stopped `App` instances would keep reacting to signals meant for their successor.

## Decision

Each handler is stored once, as a stable instance property, and reused for both `process.on()` and `process.removeListener()`:

```ts
// Stable handler refs: stored so process.removeListener() can detach them on stop().
// Inline closures would be anonymous and impossible to remove → leaked across App instances.
private readonly onUncaughtException = (error: unknown) =>
  this.uncaughtExceptionHandler(error);
private readonly onUnhandledRejection = (reason: unknown) =>
  this.uncaughtRejectionHandler(reason);
private readonly onSignalExit = () => this.exitHandler();
```

```ts
private handleProcessErrors(): void {
  process.on("uncaughtException", this.onUncaughtException);
  process.on("unhandledRejection", this.onUnhandledRejection);
}

private handleProcessExit(): void {
  process.on("SIGINT", this.onSignalExit);
  process.on("SIGTERM", this.onSignalExit);
}

private detachProcessHandlers(): void {
  process.removeListener("uncaughtException", this.onUncaughtException);
  process.removeListener("unhandledRejection", this.onUnhandledRejection);
  process.removeListener("SIGINT", this.onSignalExit);
  process.removeListener("SIGTERM", this.onSignalExit);
}
```

`detachProcessHandlers()` is called from `stop()` — the terminal phase of an `App`'s lifecycle — so a dead `App` stops reacting to signals/errors and does not interfere with a subsequently-created `App`. `process.removeListener` for an absent listener is a documented no-op, so calling `detachProcessHandlers()` is safe even when `handleProcessExit` was disabled via `AppOptions` (in which case `SIGINT`/`SIGTERM` were never attached in the first place, but `uncaughtException`/`unhandledRejection` still need detaching).

## Alternatives considered

### Inline closures registered directly on `process.on`

Rejected: no way to `removeListener` a closure that was never stored anywhere else — this is what makes the current design necessary in the first place.

### `process.once` instead of `process.on` for signal handlers

Rejected: `once` auto-removes after the first firing but doesn't address the actual problem — an `App` that never receives a signal during its lifetime (e.g. in a test that calls `stop()` directly, without ever emitting `SIGINT`) would still leak its listener, since `once`'s auto-removal is triggered by the event firing, not by `stop()` being called.

## Consequences

- **Positive**: no listener leak across `App` instances — safe for tests that construct/stop many `App`s, and for Electron main-process reloads during development.
- **Positive**: `MaxListenersExceededWarning` avoided even under repeated construction.
- **Negative**: slightly more verbose than inline closures — four extra instance fields, four explicit `removeListener` calls — a cost that only pays off because multiple `App` instances can coexist over a process's lifetime.
