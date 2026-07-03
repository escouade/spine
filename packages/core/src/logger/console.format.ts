import { inspect } from "node:util";

import { ConsoleFormatOptions } from "./logger.interface";

/** A single normalized log entry, ready to be rendered. */
export interface LogRecord {
  level: string;
  message: string;
  context?: string;
  timestamp?: string;
  stack?: string;
  /** Extra structured data appended after the message. */
  meta?: Record<string, unknown>;
}

const clc = {
  green: (text: string) => `\x1B[32m${text}\x1B[39m`,
  yellow: (text: string) => `\x1B[33m${text}\x1B[39m`,
  red: (text: string) => `\x1B[31m${text}\x1B[39m`,
  magentaBright: (text: string) => `\x1B[95m${text}\x1B[39m`,
  cyanBright: (text: string) => `\x1B[96m${text}\x1B[39m`,
};

const colorScheme: Record<string, (text: string) => string> = {
  log: clc.green,
  info: clc.green,
  error: clc.red,
  fatal: clc.red,
  warn: clc.yellow,
  debug: clc.magentaBright,
  verbose: clc.cyanBright,
};

const defaultOptions: Required<ConsoleFormatOptions> = {
  colors: process.env.NO_COLOR === undefined,
  prettyPrint: true,
  processId: true,
  appName: true,
};

const identity = (text: string): string => text;

/**
 * Renders a {@link LogRecord} as a single console line (winston-free). Layout mirrors the previous
 * winston console format: `[App] pid timestamp LEVEL [context] message - meta`, with the optional
 * stack on the next lines. `info` is displayed as `log` (NestJS-style).
 */
export function formatRecord(
  record: LogRecord,
  appName = "App",
  options: ConsoleFormatOptions = {}
): string {
  const opts = { ...defaultOptions, ...options };
  const level = record.level === "info" ? "log" : record.level;

  const color = (opts.colors && colorScheme[level]) || identity;
  const yellow = opts.colors ? clc.yellow : identity;

  const meta =
    record.meta && Object.keys(record.meta).length ? record.meta : undefined;
  const formattedMeta = meta
    ? opts.prettyPrint
      ? inspect(meta, { colors: opts.colors, depth: null })
      : safeJson(meta)
    : "";

  const line =
    (opts.appName ? color(`[${appName}]`) + " " : "") +
    (opts.processId ? color(String(process.pid)).padEnd(6) + " " : "") +
    (record.timestamp ? `${record.timestamp} ` : "") +
    `${color(level.toUpperCase().padStart(7))} ` +
    (record.context ? `${yellow("[" + record.context + "]")}` : "") +
    (record.message ? ` ${color(record.message)}` : "") +
    (formattedMeta ? ` - ${formattedMeta}` : "");

  return record.stack ? `${line}\n${record.stack}` : line;
}

/** Cycle-safe JSON for the non-pretty path (mirrors util.inspect's cycle handling). */
function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === "object") {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    return val;
  });
}
