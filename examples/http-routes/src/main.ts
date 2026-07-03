import { App, Logger } from "@spinejs/core";
import { modules } from "./app.module";

/** Boots the example App. Reused by the spec, which dispatches through the Hono app directly. */
export function createApp(options?: { logger?: Logger }): App {
  return new App(modules, {
    logger: options?.logger,
    handleProcessExit: false,
  });
}
