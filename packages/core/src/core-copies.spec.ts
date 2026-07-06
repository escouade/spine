import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "./logger";
import { App } from "./app";
import { loadedCoreCopies } from "./core-copies";

const CORE_COPIES_KEY = Symbol.for("spinejs.core.copies");
type CoreCopiesHolder = { [CORE_COPIES_KEY]?: number };
const holder = globalThis as CoreCopiesHolder;

const makeLogger = () =>
  ({
    info() {},
    error() {},
    warn: vi.fn(),
    debug() {},
    verbose() {},
    fatal() {},
    exit: async () => {},
  } as unknown as Logger);

// `App` installs process-level error handlers in its constructor (see app.spec.ts).
// Snapshot the listeners before each test and remove any the App added afterwards.
const SIGNALS = [
  "uncaughtException",
  "unhandledRejection",
  "SIGINT",
  "SIGTERM",
] as const;

let listenerSnapshot: Record<string, ((...args: unknown[]) => void)[]>;

beforeEach(() => {
  listenerSnapshot = {};
  for (const signal of SIGNALS) {
    listenerSnapshot[signal] = process
      .listeners(signal as NodeJS.Signals)
      .slice() as never;
  }
});

afterEach(() => {
  for (const signal of SIGNALS) {
    for (const listener of process.listeners(signal as NodeJS.Signals)) {
      if (!listenerSnapshot[signal].includes(listener as never)) {
        process.removeListener(signal as NodeJS.Signals, listener as never);
      }
    }
  }
});

describe("duplicate @spinejs/core detection", () => {
  const initialCount = holder[CORE_COPIES_KEY];

  afterEach(() => {
    holder[CORE_COPIES_KEY] = initialCount;
  });

  it("registers this copy once", () => {
    expect(loadedCoreCopies()).toBe(1);
  });

  it("does not warn at boot with a single copy", () => {
    const logger = makeLogger();
    new App([], { logger, handleProcessExit: false });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("warns at boot when a second copy is registered", () => {
    // Simulates a second evaluated copy of @spinejs/core: another copy would
    // bump the same Symbol.for-keyed global counter at module evaluation.
    holder[CORE_COPIES_KEY] = (holder[CORE_COPIES_KEY] ?? 1) + 1;

    const logger = makeLogger();
    new App([], { logger, handleProcessExit: false });

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const message = vi.mocked(logger.warn).mock.calls[0][0];
    expect(message).toContain("2 copies of @spinejs/core");
    expect(message).toContain("yarn why @spinejs/core");
  });
});
