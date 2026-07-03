import { describe, it, expect, vi, beforeEach } from "vitest";

const electronMock = vi.hoisted(() => {
  const state = {
    constructorOptions: [] as Record<string, unknown>[],
    windowListeners: new Map<string, ((...args: unknown[]) => void)[]>(),
    emit(event: string, ...args: unknown[]) {
      for (const handler of state.windowListeners.get(event) ?? [])
        handler(...args);
    },
    reset() {
      state.constructorOptions.length = 0;
      state.windowListeners.clear();
    },
  };
  return state;
});

const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(() => {
    throw new Error("no persisted bounds");
  }),
  writeFileSync: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/spine-electron-spec",
    isPackaged: false,
  },
  BrowserWindow: class {
    constructor(options: Record<string, unknown>) {
      electronMock.constructorOptions.push(options);
    }
    on(event: string, handler: (...args: unknown[]) => void) {
      const handlers = electronMock.windowListeners.get(event) ?? [];
      handlers.push(handler);
      electronMock.windowListeners.set(event, handlers);
    }
    loadURL = vi.fn().mockResolvedValue(undefined);
    loadFile = vi.fn().mockResolvedValue(undefined);
    getBounds = () => ({ x: 1, y: 2, width: 300, height: 200 });
  },
}));

vi.mock("node:fs", () => fsMock);

import type { Logger } from "@spinejs/core";
import { WindowService } from "./window.service";

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as Logger;

const createWindow = (
  windowOptions: Electron.BrowserWindowConstructorOptions = {}
) => {
  const service = new WindowService(silentLogger);
  service.createMainWindow(windowOptions, "http://dev", "index.html");
  return service;
};

describe("WindowService", () => {
  beforeEach(() => {
    electronMock.reset();
    fsMock.writeFileSync.mockClear();
  });

  it("applies secure webPreferences defaults", () => {
    createWindow({ width: 800 });

    expect(electronMock.constructorOptions[0]).toMatchObject({
      width: 800,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
  });

  it("lets the app's own webPreferences override the defaults", () => {
    createWindow({ webPreferences: { sandbox: false, preload: "preload.js" } });

    expect(electronMock.constructorOptions[0].webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: "preload.js",
    });
  });

  it("flushes a pending debounced bounds save when the window closes", () => {
    vi.useFakeTimers();
    try {
      createWindow();

      // A move schedules the debounced save; closing before the 300 ms
      // debounce fires must still persist the final bounds.
      electronMock.emit("move");
      electronMock.emit("close");

      expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
      const [, payload] = fsMock.writeFileSync.mock.calls[0] as [
        string,
        string
      ];
      expect(JSON.parse(payload)).toEqual({
        x: 1,
        y: 2,
        width: 300,
        height: 200,
      });

      // The cancelled timer must not double-write after close.
      vi.advanceTimersByTime(300);
      expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("persists bounds after the debounce delay on move", () => {
    vi.useFakeTimers();
    try {
      createWindow();

      electronMock.emit("move");
      expect(fsMock.writeFileSync).not.toHaveBeenCalled();

      vi.advanceTimersByTime(300);
      expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
