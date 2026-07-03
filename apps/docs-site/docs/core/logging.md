---
sidebar_position: 5
---

# Logging

SpineJS ships a zero-dependency console logger (`AppLogger`) that covers the common development and production use cases. For richer output — file transports, JSON, log rotation — the opt-in `@spinejs/winston-logger` package provides a drop-in replacement.

## Logging in your code

The active logger is registered under `loggerToken`. Inject it into any module or service and call a level method:

```typescript
import { Module, Logger, loggerToken } from "@spinejs/core";

@Module({ inject: [loggerToken] })
export class AuthModule {
  constructor(private readonly logger: Logger) {}

  async onInit(): Promise<void> {
    this.logger.info("AuthModule initialized", AuthModule.name);
  }
}
```

Type the field as `Logger` (the interface), **not** `AppLogger` — the same module then works unchanged whether the app runs the built-in logger or Winston. That is all you need day to day; the sections below cover the interface, the built-in logger's options, swapping the implementation, and the level ladder.

## The `Logger` interface

All loggers in the ecosystem implement the same interface:

```typescript
interface Logger {
  verbose(message: unknown, ...params: unknown[]): void;
  debug(message: unknown, ...params: unknown[]): void;
  info(message: unknown, ...params: unknown[]): void;
  warn(message: unknown, ...params: unknown[]): void;
  error(message: unknown, ...params: unknown[]): void;
  fatal(message: unknown, ...params: unknown[]): void;
  exit(): void | Promise<void>;
}
```

The `exit()` method is called by `app.exit()` to let the logger flush buffered writes before the process terminates.

## Built-in `AppLogger`

`AppLogger` writes colored, timestamped output to `process.stdout`/`process.stderr`. It has no external dependencies.

```typescript
import { AppLogger } from "@spinejs/core";

const logger = new AppLogger({
  level: "debug", // 'verbose' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  appName: "MyApp", // Prefix shown in brackets: [MyApp]
  stdout: true, // Write info/debug/verbose to stdout (default true)
});

logger.info("Application started", "Bootstrap");
// [timestamp] [info] [MyApp] [Bootstrap] Application started

logger.error(new Error("Something went wrong"), "AuthService");
// [timestamp] [error] [MyApp] [AuthService] Something went wrong
//   Error: Something went wrong
//     at ...
```

### `LoggerOptions`

| Option    | Type                   | Default  | Description                                                |
| --------- | ---------------------- | -------- | ---------------------------------------------------------- |
| `level`   | `LogLevel \| string`   | `'info'` | Minimum level emitted.                                     |
| `stdout`  | `boolean`              | `true`   | Emit `info` and below to `stdout` (vs `stderr`).           |
| `appName` | `string`               | `'App'`  | Prefix shown in every log line.                            |
| `console` | `ConsoleFormatOptions` | `{}`     | Fine-grained console rendering tweaks (colors, pid, etc.). |

## Custom logger

Pass any `Logger`-compatible instance to `AppOptions.logger` to replace the built-in:

```typescript
import { App } from "@spinejs/core";
import { WinstonLogger } from "@spinejs/winston-logger";

const app = new App([AppModule], {
  logger: new WinstonLogger({
    level: "debug",
    dir: "/var/log/myapp",
    files: [{ filename: "app.log" }, { filename: "error.log", level: "error" }],
  }),
});
```

See [Winston Logger](../extensions/winston-logger) for the full `WinstonLoggerOptions` reference.

## Log levels

Levels in ascending severity order:

| Level     | Method             | Use                                               |
| --------- | ------------------ | ------------------------------------------------- |
| `verbose` | `logger.verbose()` | Tracing details (container resolution, DI, etc.). |
| `debug`   | `logger.debug()`   | Development-time diagnostics.                     |
| `info`    | `logger.info()`    | Normal operational messages.                      |
| `warn`    | `logger.warn()`    | Recoverable anomalies.                            |
| `error`   | `logger.error()`   | Errors that do not crash the process.             |
| `fatal`   | `logger.fatal()`   | Errors that trigger process exit.                 |

Setting `level: 'warn'` emits only `warn`, `error`, and `fatal` — messages at lower levels are silently dropped.
