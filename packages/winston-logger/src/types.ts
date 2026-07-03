import type { ConsoleFormatOptions, LogLevel } from "@spinejs/core";

export interface LogFileConfig {
  filename?: string;
  dirname?: string;
  format?: unknown;
  [key: string]: unknown;
}

export interface WinstonLoggerOptions {
  level?: LogLevel | string;
  stdout?: boolean;
  dir?: string;
  json?: boolean;
  files?: LogFileConfig[];
  transports?: unknown[];
  console?: ConsoleFormatOptions;
  [key: string]: unknown;
}
