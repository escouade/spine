import { App, Logger } from "@spinejs/core";
import { modules } from "./app.module";

/**
 * Boots the example App. `init()` builds the graph; `start()` opens the sqlite connection (with retry)
 * and creates the schema. Reused by the spec, which mocks `electron` to drive IPC dispatches headlessly.
 */
export function createApp(options?: { logger?: Logger }): App {
  return new App(modules, {
    logger: options?.logger,
    handleProcessExit: false,
  });
}
