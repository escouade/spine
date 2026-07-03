import { Format } from "logform";
import { format } from "winston";
import { inspect } from "util";
import safeStringify from "fast-safe-stringify";

import type { ConsoleFormatOptions } from "@spinejs/core";

const clc = {
  bold: (text: string) => `\x1B[1m${text}\x1B[0m`,
  green: (text: string) => `\x1B[32m${text}\x1B[39m`,
  yellow: (text: string) => `\x1B[33m${text}\x1B[39m`,
  red: (text: string) => `\x1B[31m${text}\x1B[39m`,
  magentaBright: (text: string) => `\x1B[95m${text}\x1B[39m`,
  cyanBright: (text: string) => `\x1B[96m${text}\x1B[39m`,
};

const colorScheme: Record<string, (text: string) => string> = {
  log: clc.green,
  error: clc.red,
  warn: clc.yellow,
  debug: clc.magentaBright,
  verbose: clc.cyanBright,
};

const defaultOptions: ConsoleFormatOptions = {
  colors: process.env.NO_COLOR === undefined,
  prettyPrint: true,
  processId: true,
  appName: true,
};

export const consoleFormat = (
  appName = "App",
  options: ConsoleFormatOptions = {}
): Format => {
  // Merge default options with user-provided options
  const formatOptions: ConsoleFormatOptions = {
    ...defaultOptions,
    ...options,
  };

  return format.printf(
    ({ context, level, timestamp, message, ms, ...meta }) => {
      if ("info" === level) {
        level = "log";
      }

      if ("undefined" !== typeof timestamp) {
        // Only format the timestamp to a locale representation if it's ISO 8601 format. Any format
        // that is not a valid date string will throw, just ignore it (it will be printed as-is).
        try {
          if (timestamp === new Date(timestamp as number).toISOString()) {
            timestamp = new Date(timestamp).toLocaleString();
          }
        } catch {
          // not a valid date string: leave the timestamp as-is
        }
      }

      const color =
        (formatOptions.colors && colorScheme[level]) ||
        ((text: string): string => text);
      const yellow = formatOptions.colors
        ? clc.yellow
        : (text: string): string => text;

      const stringifiedMeta = safeStringify(meta);
      const formattedMeta = formatOptions.prettyPrint
        ? inspect(JSON.parse(stringifiedMeta), {
            colors: formatOptions.colors,
            depth: null,
          })
        : stringifiedMeta;

      return (
        (formatOptions.appName ? color(`[${appName}]`) + " " : "") +
        (formatOptions.processId
          ? color(String(process.pid)).padEnd(6) + " "
          : "") +
        ("undefined" !== typeof timestamp ? `${timestamp} ` : "") +
        `${color(level.toUpperCase().padStart(7))} ` +
        ("undefined" !== typeof context
          ? `${yellow("[" + context + "]")}`
          : "") +
        ("undefined" !== typeof message ? ` ${color(message as string)}` : "") +
        (formattedMeta && formattedMeta !== "{}" ? ` - ${formattedMeta}` : "") +
        ("undefined" !== typeof ms ? ` ${yellow(ms as string)}` : "")
      );
    }
  );
};
