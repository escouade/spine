---
sidebar_position: 1
---

# Overview

`@spinejs/core` is the foundational layer of the ecosystem. It provides three primitives that every SpineJS application is built from: the **module system** (structural unit of code), the **DI container** (dependency wiring), and the **App orchestrator** (lifecycle management and process signal handling).

## The `App` class

`App` is the entry point. It accepts a list of `ModuleEntry` values, wires up the DI container, and drives the `init → start → stop` lifecycle.

```typescript
import { App } from "@spinejs/core";
import { ConfigModule } from "@spinejs/config";
import { AppModule } from "./app.module";

const app = new App([ConfigModule.configure({ configs: [] }), AppModule], {
  // Optional: swap the built-in console logger for a Winston instance.
  // logger: new WinstonLogger({ level: 'debug', dir: '/var/log/myapp' }),

  // Optional: control the minimum log level of the built-in console logger.
  loggerOptions: { level: process.env.LOG_LEVEL ?? "info" },
});

await app.init(); // Build the module graph, run onInit() on every module.
await app.start(); // Run onStart() on every module that implements OnStart.
```

### `AppOptions`

| Option              | Type            | Default     | Description                                                                           |
| ------------------- | --------------- | ----------- | ------------------------------------------------------------------------------------- |
| `logger`            | `Logger`        | `AppLogger` | Custom logger instance (replaces the built-in).                                       |
| `loggerOptions`     | `LoggerOptions` | `{}`        | Options forwarded to the built-in `AppLogger`.                                        |
| `handleProcessExit` | `boolean`       | `true`      | When `true`, listens for `SIGINT`/`SIGTERM` and calls `app.exit()`.                   |
| `shutdownTimeout`   | `number`        | `5000`      | Max ms for the shutdown sequence before `exit()` force-exits; `0` waits indefinitely. |

### Methods

| Method        | Description                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `init()`      | Loads all modules in dependency order, calling `onInit()` on each. Throws (and self-stops) on any error. |
| `start()`     | Calls `onStart()` on each module that implements `OnStart`. Throws (and self-stops) on any error.        |
| `stop()`      | Calls `onStop()` in reverse init order. Idempotent — safe to call multiple times.                        |
| `exit(code?)` | Stops the app, flushes the logger, then calls `process.exit(code)`. Re-entrant-safe.                     |

## Global tokens

Two `InjectionToken` values are pre-registered in every app's global container:

```typescript
import { appToken, loggerToken } from "@spinejs/core";

@Module({
  inject: [appToken, loggerToken],
})
export class MyModule {
  constructor(private readonly app: App, private readonly logger: Logger) {}
}
```

- **`appToken`** — resolves the `App` instance itself. Useful when a module needs to trigger a graceful shutdown (e.g. `ElectronModule` intercepts `before-quit`).
- **`loggerToken`** — resolves the active `Logger` (either `AppLogger` or a custom logger passed in `AppOptions`).

## Process signal handling

By default, `App` registers listeners for `SIGINT` and `SIGTERM` that call `app.exit()`. Both signals trigger a graceful shutdown: all `onStop()` hooks run, the logger flushes, then the process exits with code `0`.

Uncaught exceptions and unhandled promise rejections are also intercepted: the error is logged, then `app.exit(1)` is called.

When the app stops (successfully or after an error), these listeners are removed automatically to prevent spurious re-triggering.
