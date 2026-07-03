import { describe, it, expect, vi, beforeEach } from "vitest";

const electronMock = vi.hoisted(() => {
  const appListeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const windows: unknown[] = [];
  return {
    appListeners,
    windows,
    emit(event: string, ...args: unknown[]) {
      for (const handler of appListeners.get(event) ?? []) handler(...args);
    },
    reset() {
      appListeners.clear();
      windows.length = 0;
    },
  };
});

vi.mock("electron", () => ({
  app: {
    whenReady: () => Promise.resolve(),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      const handlers = electronMock.appListeners.get(event) ?? [];
      handlers.push(handler);
      electronMock.appListeners.set(event, handlers);
    },
    getPath: () => "/tmp/spine-electron-spec",
    isPackaged: false,
    quit: vi.fn(),
  },
  BrowserWindow: class {
    static getAllWindows = () => electronMock.windows;
  },
}));

import type { App, Logger } from "@spinejs/core";
import { ElectronModule } from "./electron.module";
import type { WindowService } from "./window.service";

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as Logger;

const options = { window: {}, devUrl: "http://dev", packagePath: "index.html" };

function makeModule() {
  const windowService = { createMainWindow: vi.fn() };
  const module = new ElectronModule(
    { stop: vi.fn().mockResolvedValue(undefined) } as unknown as App,
    silentLogger,
    options,
    windowService as unknown as WindowService
  );
  return { module, windowService };
}

describe("ElectronModule", () => {
  beforeEach(() => electronMock.reset());

  it("registers the activate listener once in onInit, not per createMainWindow call", async () => {
    const { module } = makeModule();
    await module.onInit();

    module.createMainWindow();
    module.createMainWindow();
    module.createMainWindow();

    expect(electronMock.appListeners.get("activate")).toHaveLength(1);
  });

  it("does not open a window on activate before the app requested one", async () => {
    const { module, windowService } = makeModule();
    await module.onInit();

    electronMock.emit("activate");

    expect(windowService.createMainWindow).not.toHaveBeenCalled();
  });

  it("re-creates the main window on activate when none is open", async () => {
    const { module, windowService } = makeModule();
    await module.onInit();
    module.createMainWindow();

    electronMock.emit("activate");

    expect(windowService.createMainWindow).toHaveBeenCalledTimes(2);
  });

  it("does not re-create the main window on activate while one is open", async () => {
    const { module, windowService } = makeModule();
    await module.onInit();
    module.createMainWindow();
    electronMock.windows.push({});

    electronMock.emit("activate");

    expect(windowService.createMainWindow).toHaveBeenCalledTimes(1);
  });
});
