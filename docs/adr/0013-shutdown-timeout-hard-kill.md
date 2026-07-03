# ADR 0013 — Shutdown timeout with hard-kill fallback

- **Status**: Accepted
- **Date**: 2026-07-02
- **Scope**: `packages/core` (`app.ts`, `types.ts`)
- **Relation**: wraps [ADR 0010](./0010-atomic-module-lifecycle.md)'s `stop()` (reverse-order `onStop()`).

## Context

`App.exit()` awaits a graceful shutdown: `stop()` (runs every module's `onStop()`) then `logger.exit()` (flushes pending logs). Either step can hang — a module's `onStop()` awaiting an I/O call that never resolves, or a logger transport whose flush deadlocks. Without a fallback, a hung shutdown means a zombie process: something that received `SIGTERM`/`SIGINT`, "started shutting down," and then never actually exits — the kind of failure that's invisible until an orchestrator (Docker, systemd, Kubernetes) has to `SIGKILL` it after its own grace period.

The framework's position: **a dangling shutdown is worse than an abrupt exit.** Given the choice between waiting forever for a hook that may never resolve, and force-exiting past a bounded budget, force-exiting wins.

## Decision

```ts
public async exit(code = 0): Promise<void> {
  if (this.exiting) return;
  this.exiting = true;

  const hardKill = this.shutdownTimeout
    ? setTimeout(() => {
        this.logger.error(
          `⌛ Graceful shutdown exceeded ${this.shutdownTimeout}ms, forcing exit`,
          App.name
        );
        process.exit(code);
      }, this.shutdownTimeout)
    : undefined;

  try {
    await this.stop();
  } catch (e) {
    this.logger.error(e, App.name);
  }

  if (!this.hasExitLogger) {
    this.hasExitLogger = true;
    await this.logger.exit();
  }

  if (hardKill) clearTimeout(hardKill);
  process.exit(code);
}
```

### 1. Configurable budget, opt-out via `0`

`AppOptions.shutdownTimeout` (default `5_000`ms) bounds the graceful path. `0` disables the hard-kill timer entirely and waits indefinitely — an explicit escape hatch for cases where a bounded shutdown is actively wrong (e.g. a long batch flush that must complete).

### 2. Re-entrance guard, but not around the timer

`this.exiting` makes `exit()` idempotent for a _first_ caller — a second concurrent call is a no-op. But the hard-kill `setTimeout` is armed on **every** call that passes the guard, i.e. only once per process (since the guard blocks re-entry). If the first `exit()` call is genuinely hung past its timeout, the hard-kill fires unconditionally via `process.exit()` — it does not itself check `this.exiting`, so it always fires regardless of what the graceful path is doing.

### 3. `stop()` errors don't block the logger flush or the exit

A thrown error from `stop()` (e.g. a module's `onStop()` throwing) is caught and logged, not rethrown — shutdown must still reach `logger.exit()` and `process.exit()` rather than leaving the process in a partially-torn-down, still-running state because one module's cleanup failed.

## Alternatives considered

### No timeout — always wait for graceful shutdown to finish

Rejected: a single hung `onStop()` or logger flush becomes a permanently zombie process, relying entirely on an external supervisor's `SIGKILL` grace period as the only way out.

### Hard-kill via a second signal only (no timer)

Considered (and still works as a side effect: a second `SIGINT`/`SIGTERM` re-enters `exitHandler` → `exit()`, which is a no-op due to the re-entrance guard, but the process is still alive to receive and act on operator-sent signals) — but rejected as the _sole_ mechanism: it requires an operator or supervisor to notice the hang and manually send a second signal, rather than the process protecting itself automatically.

## Consequences

- **Positive**: bounded shutdown time by default — no indefinite zombie process from a single hung hook.
- **Positive**: `shutdownTimeout: 0` remains available for workloads that need an unbounded graceful window.
- **Negative**: a shutdown that hits the timeout may lose in-flight work in whatever hook was still running (e.g. an unflushed log batch, an incomplete write) — the hard-kill is intentionally abrupt.
- **Caution**: the default 5000ms may be too short for slow I/O during shutdown (e.g. large batch flushes) — should be tuned per-deployment via `shutdownTimeout` rather than assumed universal.
