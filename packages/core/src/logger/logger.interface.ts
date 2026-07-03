export interface ConsoleFormatOptions {
  colors?: boolean;
  prettyPrint?: boolean;
  processId?: boolean;
  appName?: boolean;
}

export type LogLevel =
  | "error"
  | "warn"
  | "info"
  | "verbose"
  | "debug"
  | "silly";

export interface Logger {
  info(message: unknown, ...optionalParams: unknown[]): void;
  error(message: unknown, ...optionalParams: unknown[]): void;
  warn(message: unknown, ...optionalParams: unknown[]): void;
  debug(message: unknown, ...optionalParams: unknown[]): void;
  verbose(message: unknown, ...optionalParams: unknown[]): void;
  fatal(message: unknown, ...optionalParams: unknown[]): void;
  exit(): Promise<void>;
}
