---
sidebar_position: 2
---

# Winston Logger

`@spinejs/winston-logger` provides a production-grade logger for SpineJS applications. It implements the `Logger` interface from `@spinejs/core`, making it a drop-in replacement for the built-in `AppLogger`. The Winston dependency and its transitive deps (winston, logform, triple-beam) live in this package — the SpineJS core stays zero-dependency.

## Installation

Pass a `WinstonLogger` instance to `AppOptions.logger` when constructing your `App`:

```typescript
import { App } from "@spinejs/core";
import { WinstonLogger } from "@spinejs/winston-logger";

const app = new App([AppModule], {
  logger: new WinstonLogger({
    level: "info",
    stdout: true,
    dir: "/var/log/myapp",
    files: [{ filename: "app.log" }, { filename: "error.log", level: "error" }],
  }),
});
```

That is the only change needed. The `WinstonLogger` instance is automatically registered under `loggerToken` and injected into any module that requests it.

## `WinstonLoggerOptions`

| Option       | Type                   | Default                    | Description                                                             |
| ------------ | ---------------------- | -------------------------- | ----------------------------------------------------------------------- |
| `level`      | `LogLevel \| string`   | Winston default (`'info'`) | Minimum log level emitted.                                              |
| `stdout`     | `boolean`              | `true`                     | When `true`, adds a Console transport with colored output.              |
| `dir`        | `string`               | —                          | Base directory for file transports. Required when `files` is non-empty. |
| `json`       | `boolean`              | `false`                    | Emit file logs as JSON (currently disabled — reserved for future use).  |
| `files`      | `LogFileConfig[]`      | `[]`                       | Array of file transport configurations (see below).                     |
| `transports` | `unknown[]`            | `[]`                       | Raw Winston transports to add (for advanced use cases).                 |
| `console`    | `ConsoleFormatOptions` | —                          | Tweaks to the console formatter (colors, timestamps, pid).              |

## File transports with `LogFileConfig`

`LogFileConfig` mirrors Winston's `FileTransportOptions`. At minimum you need `filename`:

```typescript
import { WinstonLogger } from "@spinejs/winston-logger";

const logger = new WinstonLogger({
  dir: "/var/log/myapp",
  files: [
    // All log levels:
    { filename: "combined.log" },
    // Errors only:
    { filename: "error.log", level: "error" },
    // Rotating files (requires winston-daily-rotate-file transport in `transports`):
    { filename: "app-%DATE%.log" },
  ],
});
```

The `dir` option is spread into each `LogFileConfig.dirname` automatically. Custom `format` can be set per file — when absent, a default text format `[timestamp] [level] message` is used.

## Log level inheritance

Each file transport respects its own `level`. The logger-wide `level` acts as the floor — a transport with `level: 'error'` still only receives errors even if the logger's `level` is `'debug'`.

```typescript
const logger = new WinstonLogger({
  level: "debug", // console receives everything from debug up
  files: [
    { filename: "debug.log", level: "debug" }, // all levels
    { filename: "error.log", level: "error" }, // only error and fatal
  ],
});
```

## Advanced: raw Winston transports

Pass any Winston-compatible transport via the `transports` option:

```typescript
import * as winston from "winston";
import { WinstonLogger } from "@spinejs/winston-logger";
import DailyRotateFile from "winston-daily-rotate-file";

const logger = new WinstonLogger({
  level: "info",
  transports: [
    new DailyRotateFile({
      dirname: "/var/log/myapp",
      filename: "app-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxFiles: "14d",
    }),
  ],
});
```

## `exit()` — flush on shutdown

`WinstonLogger` implements `Logger.exit()` by calling `winston.end()` and waiting up to 200 ms for buffered writes to drain. `App.exit()` calls this automatically before `process.exit()`.

If you use file transports, ensure `logger.exit()` has time to complete. The `App` handles this for you when you pass the logger as `AppOptions.logger`.

## Error handling

If a file transport encounters a permission error (`EACCES`), the logger throws immediately during construction. Other transport errors are caught and re-logged.

```typescript
// This throws if /root/logs is not writable:
const logger = new WinstonLogger({
  dir: "/root/logs",
  files: [{ filename: "app.log" }],
});
```

Validate write permissions before construction in production (e.g. `accessSync` or a startup health check).

## Using the logger in modules

The logger is accessible via `loggerToken` in any module once the app is booted. The type is the `Logger` interface — your module stays decoupled from the concrete `WinstonLogger` class:

```typescript
import { Module, Logger, loggerToken } from "@spinejs/core";

@Module({ inject: [loggerToken] })
export class MyModule {
  constructor(private readonly logger: Logger) {}

  async onInit(): Promise<void> {
    this.logger.info("MyModule is ready", MyModule.name);
  }
}
```
