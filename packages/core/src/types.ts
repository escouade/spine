import {
  ConsoleFormatOptions,
  Logger,
  LogLevel,
} from "./logger/logger.interface";

export interface LoggerOptions {
  /** Minimum level emitted (default `'info'`). */
  level?: LogLevel | string;
  /** Write to the console (default `true`). */
  stdout?: boolean;
  /** Name shown in the log prefix (default `'App'`). */
  appName?: string;
  /** Console rendering tweaks (colors, pretty-print, pid, app name). */
  console?: ConsoleFormatOptions;
}

export interface AppOptions {
  handleProcessExit?: boolean;
  logger?: Logger;
  loggerOptions?: LoggerOptions;
  /**
   * Max time (ms) given to `onStop()` hooks before `exit()` gives up waiting and force-exits
   * the process. Default `5000`. Set to `0` to wait indefinitely.
   */
  shutdownTimeout?: number;
}
