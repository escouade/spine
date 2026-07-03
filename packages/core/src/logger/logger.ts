import { isObject } from "../utils";
import type { LoggerOptions } from "../types";
import { Logger } from "./logger.interface";
import { formatRecord, type LogRecord } from "./console.format";

/** Severity order (low number = higher priority). `fatal` aliases the top of the `error` band. */
const LEVEL_WEIGHT: Record<string, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  verbose: 4,
  debug: 5,
  silly: 6,
};

/** Levels routed to stderr rather than stdout. */
const STDERR_LEVELS = new Set(["fatal", "error", "warn"]);

/**
 * Minimal, dependency-free console logger (the app-core default). Writes one formatted line per
 * call to stdout/stderr. For file transports, JSON output or custom transports, use
 * `@spinejs/winston-logger`, which implements the same {@link Logger} port.
 *
 * Argument convention (kept from the previous winston logger): a trailing `string` is the context
 * tag, a trailing object is merged as metadata, and an `Error`/object message contributes its own
 * fields.
 */
export class AppLogger implements Logger {
  private readonly stdout: boolean;
  private readonly appName: string;
  private readonly threshold: number;
  private readonly consoleOptions: LoggerOptions["console"];

  constructor(options: LoggerOptions = {}) {
    this.stdout = options.stdout ?? true;
    this.appName = options.appName ?? "App";
    this.consoleOptions = options.console;
    this.threshold = LEVEL_WEIGHT[options.level ?? "info"] ?? LEVEL_WEIGHT.info;
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.write("verbose", message, optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.write("debug", message, optionalParams);
  }

  info(message: unknown, ...optionalParams: unknown[]): void {
    this.write("info", message, optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.write("warn", message, optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.write("error", message, optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.write("fatal", message, optionalParams);
  }

  /** No async transports to flush — resolves immediately (kept for the {@link Logger} contract). */
  async exit(): Promise<void> {
    return;
  }

  private write(level: string, rawMessage: unknown, params: unknown[]): void {
    if (!this.stdout) return;
    if ((LEVEL_WEIGHT[level] ?? LEVEL_WEIGHT.info) > this.threshold) return;

    const meta: Record<string, unknown> = {};
    const extra = [...params];

    // Trailing string = context tag.
    let context: string | undefined;
    if (typeof extra[extra.length - 1] === "string") {
      context = extra.pop() as string;
    }
    // Next trailing object = metadata.
    const last = extra[extra.length - 1];
    if (isObject(last)) {
      Object.assign(meta, extra.pop());
    }

    const record: LogRecord = {
      level,
      message: "",
      context,
      timestamp: new Date().toLocaleString(),
    };

    if (rawMessage instanceof Error) {
      record.message = rawMessage.message;
      record.stack = rawMessage.stack;
      if (rawMessage instanceof AggregateError && rawMessage.errors?.length) {
        const causeStacks = rawMessage.errors
          .map((e: unknown, i: number) =>
            e instanceof Error
              ? `  Cause [${i}] ${e.constructor.name}: ${e.stack ?? e.message}`
              : `  Cause [${i}]: ${String(e)}`
          )
          .join("\n");
        record.stack = (record.stack ?? "") + "\n" + causeStacks;
      }
    } else if (isObject(rawMessage)) {
      const { message: msg, ...rest } = rawMessage as Record<string, unknown>;
      record.message = typeof msg === "string" ? msg : "";
      Object.assign(meta, rest);
    } else {
      record.message = rawMessage === undefined ? "" : String(rawMessage);
    }

    // Any leftover positional params are surfaced rather than dropped.
    if (extra.length) meta.args = extra;
    if (Object.keys(meta).length) record.meta = meta;

    const line = formatRecord(record, this.appName, this.consoleOptions);
    const stream = STDERR_LEVELS.has(level) ? process.stderr : process.stdout;
    stream.write(line + "\n");
  }
}
