import { App, Logger } from "@spinejs/core";
import { modules } from "./app.module";

/** Boots the example App. Reused by the spec (which mocks `electron` to drive dispatches). */
export function createApp(options?: { logger?: Logger }): App {
  return new App(modules, {
    logger: options?.logger,
    handleProcessExit: false,
  });
}
