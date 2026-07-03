# @spinejs/winston-logger

Production-grade logger for SpineJS. Implements the `Logger` interface from `@spinejs/core` — a drop-in replacement for the built-in `AppLogger`. Keeps Winston and its transitive deps out of `@spinejs/core`.

## Quick start

Pass a `WinstonLogger` to `AppOptions.logger`. It registers under `loggerToken` automatically — no further wiring.

```typescript
import { App } from "@spinejs/core";
import { WinstonLogger } from "@spinejs/winston-logger";

const app = new App([AppModule], {
  logger: new WinstonLogger({
    level: process.env.LOG_LEVEL ?? "info",
    stdout: true,
    dir: "/var/log/myapp",
    files: [{ filename: "app.log" }, { filename: "error.log", level: "error" }],
  }),
});
```

Then inject it anywhere as `Logger` (the interface) — your modules stay decoupled from the implementation:

```typescript
import { Module, Logger, loggerToken } from "@spinejs/core";

@Module({ inject: [loggerToken] })
export class MyModule {
  constructor(private readonly logger: Logger) {}
  async onInit() {
    this.logger.info("ready", MyModule.name);
  }
}
```

## Rotating file transport

Pass raw Winston transports via `transports`:

```typescript
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

## Reference

### `WinstonLoggerOptions`

| Option       | Type                   | Default  | Description                                                             |
| ------------ | ---------------------- | -------- | ----------------------------------------------------------------------- |
| `level`      | `string`               | `'info'` | Minimum log level.                                                      |
| `stdout`     | `boolean`              | `true`   | Add a Console transport with colored output.                            |
| `dir`        | `string`               | —        | Base directory for file transports. Required when `files` is non-empty. |
| `files`      | `LogFileConfig[]`      | `[]`     | File transport configs (`filename`, optionally `level`, `format`, …).   |
| `transports` | `unknown[]`            | `[]`     | Raw Winston transports (e.g. `DailyRotateFile`).                        |
| `console`    | `ConsoleFormatOptions` | —        | Console formatter tweaks (colors, timestamps, pid).                     |

**Flush on shutdown:** `WinstonLogger.exit()` drains Winston transports (max 200 ms); `App.exit()` calls it automatically before `process.exit()`.

## Full docs

[apps/docs-site/docs/extensions/winston-logger](../../apps/docs-site/docs/extensions/winston-logger.md)
