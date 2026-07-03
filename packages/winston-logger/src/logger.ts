import * as winston from "winston";
import { SPLAT } from "triple-beam";

import { isObject, type Logger } from "@spinejs/core";
import type { LogFileConfig, WinstonLoggerOptions } from "./types";
import { consoleFormat } from "./console.format";

const { combine, timestamp } = winston.format;

/** Winston format for file transports (text or json). */
function logFormat(json?: boolean): winston.Logform.Format | undefined {
  const formatMessage = (log: winston.Logform.TransformableInfo): string =>
    `${log.timestamp} [${log.level}] ${log.message}`;

  const msg = (log: winston.Logform.TransformableInfo): string => {
    if (log.stack) {
      return `${log.timestamp} [${log.level}] ${log.message}\n${log.stack}`;
    } else if (isObject(log.message) || Array.isArray(log.message)) {
      log.message = JSON.stringify(log.message, null, "  ");
      return formatMessage(log);
    }
    return formatMessage(log);
  };

  if (json) {
    return undefined; // json format disabled (cf. original version)
  }
  return combine(timestamp(), winston.format.printf(msg));
}

/**
 * Winston-backed logger (stdout + optional file transports). Implements the app-core `Logger`
 * port, so it can be passed as `AppOptions.logger` to replace the minimal default logger when
 * file transports / richer formatting are needed.
 */
export class WinstonLogger implements Logger {
  private readonly options: WinstonLoggerOptions;
  private winston!: winston.Logger;
  private exiting = false;

  constructor(options: WinstonLoggerOptions = {}) {
    this.options = Object.assign(
      { stdout: true, files: [] as LogFileConfig[] },
      options
    );
    this.init();
  }

  private init(): void {
    if (this.options.files && this.options.files.length && !this.options.dir)
      throw new Error("Logger: Missing dir in logger config !");

    const transports = (this.options.transports ?? []) as winston.transport[];
    transports.push(
      ...(this.options.files ?? []).map((file) => this.getFileTransport(file))
    );

    this.winston = winston.createLogger({
      level: this.options.level,
      transports,
    });

    if (this.options.stdout) {
      this.winston.add(
        new winston.transports.Console({ format: consoleFormat() })
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.winston.on("error", (error: any) => {
      let exit = false;
      if (!this.exiting) {
        this.exiting = true;
        exit = true;
      }

      let message = error;
      if (error.code === "EACCES") {
        message = "permission denied on log file: " + error.path;
      }

      if (exit) {
        throw new Error(message);
      } else {
        void this.error(new Error(message));
      }
    });
  }

  private getFileTransport(file: LogFileConfig): winston.transport {
    file.dirname = this.options.dir;
    file.format = file.format ?? logFormat(this.options.json);
    return new winston.transports.File(
      file as winston.transports.FileTransportOptions
    );
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.log(message, "verbose", ...optionalParams);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    this.log(message, "debug", ...optionalParams);
  }

  info(message: unknown, ...optionalParams: unknown[]): void {
    this.log(message, "info", ...optionalParams);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    this.log(message, "warn", ...optionalParams);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.logError(message, "fatal", ...optionalParams);
  }

  error(message: unknown, ...optionalParams: unknown[]): void {
    this.logError(message, "error", ...optionalParams);
  }

  private logError(
    message: unknown,
    level: string,
    ...optionalParams: unknown[]
  ): void {
    let metadata: { [name: string]: unknown } = {};
    let lastElement = optionalParams[optionalParams.length - 1];
    const isContext = typeof lastElement === "string";

    // if last param is string, it the context
    if (isContext) {
      metadata["context"] = optionalParams.pop();
    }

    lastElement = optionalParams[optionalParams.length - 1];
    // If next last element is an object it metadata
    if (!!lastElement && typeof lastElement === "object") {
      metadata = { ...metadata, ...lastElement };
      optionalParams.splice(-1);
    }

    lastElement = optionalParams[optionalParams.length - 1];
    // if the next last param is string it stack trace
    const isTrace = typeof lastElement === "string";
    if (isTrace) {
      metadata["stack"] = [optionalParams.pop()];
    }

    if (message instanceof Error) {
      const { message: msg, stack, ...meta } = message;
      this.winston.log({
        stack: [stack],
        ...meta,
        ...metadata,
        error: message,
        level,
        message: msg,
        [SPLAT]: optionalParams,
      });
      return;
    }

    if (!!message && "object" === typeof message) {
      const { message: msg, ...meta } = message as Record<string, unknown>;

      this.winston.log({
        ...meta,
        ...metadata,
        message: msg as string,
        level,
        [SPLAT]: optionalParams,
      });
      return;
    }

    this.winston.log({
      ...metadata,
      level,
      message: message as string,
      [SPLAT]: optionalParams,
    });
  }

  private log(
    message: unknown,
    logLevel: string,
    ...optionalParams: unknown[]
  ): void {
    let metadata: { [name: string]: unknown } = {};
    let lastElement = optionalParams[optionalParams.length - 1];
    const isContext = typeof lastElement === "string";

    // if last param is string, it the context
    if (isContext) {
      metadata["context"] = optionalParams.pop();
    }

    lastElement = optionalParams[optionalParams.length - 1];
    // If next last element is an object it metadata
    if (!!lastElement && typeof lastElement === "object") {
      metadata = { ...metadata, ...lastElement };
      optionalParams.splice(-1);
    }

    if (!!message && "object" === typeof message) {
      const {
        message: msg,
        level = logLevel || "info",
        ...meta
      } = message as Record<string, unknown>;

      this.winston.log({
        ...meta,
        ...metadata,
        level: level as string,
        message: msg as string,
        [SPLAT]: optionalParams,
      });
      return;
    }
    this.winston.log({
      ...metadata,
      level: logLevel,
      message: message as string,
      [SPLAT]: optionalParams,
    });
  }

  private async waitWinston(wait: number, interval: number): Promise<void> {
    wait -= interval;
    if (this.winston.transports.length && wait > 0) {
      await this.wait(interval);
      return this.waitWinston(wait, interval);
    }
  }

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async exit(): Promise<void> {
    const wait = 200;
    const interval = 100;
    this.winston.end();
    if (this.winston.transports.length) {
      await this.waitWinston(wait, interval);
    }
  }
}
