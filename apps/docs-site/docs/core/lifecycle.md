---
sidebar_position: 4
---

# Lifecycle

SpineJS orchestrates module initialization and teardown through three optional interfaces: `OnInit`, `OnStart`, and `OnStop`. Implementing them is entirely opt-in — a module that does not need lifecycle hooks simply does not implement them.

## Interfaces

```typescript
interface OnInit {
  onInit(): void | Promise<void>;
}
interface OnStart {
  onStart(): void | Promise<void>;
}
interface OnStop {
  onStop(): void | Promise<void>;
}
```

All three methods may be `async`. SpineJS `await`s each one before moving to the next module.

## Phase 1 — `init()` and `onInit()`

`app.init()` loads the module graph. The loader performs a topological sort so that a module's dependencies are always initialized before the module itself.

Within each module, the sequence is:

1. Resolve all providers via DI.
2. Instantiate the module class (inject constructor deps).
3. Call `onInit()` if the module implements `OnInit`.

```typescript
@Module({
  inject: [DatabaseService],
  imports: [DatabaseModule],
})
export class UserModule implements OnInit {
  constructor(private readonly db: DatabaseService) {}

  async onInit(): Promise<void> {
    // DatabaseModule.onInit() has already run at this point.
    await this.db.createSchema();
  }
}
```

### Atomic boot

If any module's `onInit()` throws, `app.init()` calls `app.stop()` before re-throwing. Modules that had successfully completed `onInit()` receive their `onStop()` call; the failing module does not (it never entered the initialized set). This ensures no partially-booted state is left running.

```typescript
try {
  await app.init();
  await app.start();
} catch (err) {
  // app.stop() has already been called — safe to exit.
  await app.exit(1);
}
```

## Phase 2 — `start()` and `onStart()`

`app.start()` runs after `app.init()` completes. It calls `onStart()` on every module that implements `OnStart`, again in init order (dependencies before dependents).

`onStart()` is intended for work that must happen after the entire module graph is initialized — for example, starting a server that other modules might connect to, or running migrations that depend on the database being fully configured.

```typescript
@Module({ inject: [HttpServer] })
export class ServerModule implements OnStart {
  constructor(private readonly server: HttpServer) {}

  async onStart(): Promise<void> {
    await this.server.listen(3000);
  }
}
```

Like `init()`, if any `onStart()` throws, `app.stop()` is called before re-throwing.

:::note `start()` is terminal after `stop()`
Calling `app.start()` after `app.stop()` throws immediately. Calling it a second time on a running app is a no-op.
:::

## Phase 3 — `stop()` and `onStop()`

`app.stop()` is called on `SIGINT`, `SIGTERM`, uncaught exceptions, or manually via `app.stop()`. It calls `onStop()` in **reverse init order** — dependents shut down before their dependencies.

`onStop()` pairs with `onInit()`, not with `onStart()`. A module that completed `onInit()` is guaranteed to receive `onStop()` during shutdown, regardless of whether `onStart()` was called or completed successfully.

```typescript
@Module({ inject: [DatabaseService] })
export class DatabaseModule implements OnInit, OnStop {
  constructor(private readonly db: DatabaseService) {}

  async onInit(): Promise<void> {
    await this.db.connect();
  }

  async onStop(): Promise<void> {
    // Runs after all modules that imported DatabaseModule have stopped.
    await this.db.disconnect();
  }
}
```

### Idempotency

`app.stop()` is idempotent: calling it multiple times is safe. The second call is a no-op. This is important because `app.exit()` calls `stop()`, and the process-signal handler also calls `exit()` — without idempotency, a race between a SIGTERM and an explicit `app.exit()` would double-call `onStop()` hooks.

## `exit()` — clean process shutdown

`app.exit(code?)` performs a full shutdown:

1. Calls `app.stop()` (idempotent — safe if already stopped).
2. Calls `logger.exit()` to flush any buffered log entries.
3. Calls `process.exit(code)`.

It is re-entrant safe: a duplicate call (e.g. from a second signal) is ignored after the first has started.

### Shutdown timeout (force exit)

Because SpineJS intercepts `SIGINT`/`SIGTERM` and owns the call to `process.exit()`, it also guarantees the process actually terminates. A hung `onStop()` (a dangling connection, a stuck flush) must not keep the process alive forever — otherwise it would defeat the orchestrator's own kill window.

`exit()` arms a hard-kill timer over the whole shutdown sequence: if `stop()` plus the logger flush do not complete within `shutdownTimeout` (default `5000` ms), the process is force-exited. The clean path clears the timer before its own `process.exit()`.

```typescript
const app = new App([AppModule], {
  shutdownTimeout: 3000, // force exit after 3s; 0 disables (wait indefinitely)
});
```

Keep `shutdownTimeout` below your orchestrator's grace period (e.g. Docker's default 10s before `SIGKILL`) so the framework's force-exit fires first.

```typescript
// Graceful shutdown from application logic:
const app = new App([AppModule]);
await app.init();
await app.start();

// Later, e.g. from a management API:
await app.exit(0);
```

## Lifecycle flow diagram

```
new App(modules)
  └─ constructor: global container initialized, process handlers attached

app.init()
  └─ topological sort of module graph
  └─ for each module (deps before dependents):
       resolve providers → instantiate module → onInit() [await]
  └─ on any error: stop() → re-throw

app.start()
  └─ for each module (same order as init):
       onStart() [await]
  └─ on any error: stop() → re-throw

app.stop()  [idempotent]
  └─ for each module (reverse init order):
       onStop() [await]
  └─ detach process listeners

app.exit(code)  [re-entrant-safe]
  └─ arm hard-kill timer (shutdownTimeout) ── on timeout ─→ process.exit(code)
  └─ stop()
  └─ logger.exit()
  └─ clear hard-kill timer
  └─ process.exit(code)
```
