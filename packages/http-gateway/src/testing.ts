import type { Logger } from "@spinejs/core";

/** No-op `Logger`, for specs that boot a real `App` and don't want boot/shutdown noise. */
export const silentLogger: Logger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
};
