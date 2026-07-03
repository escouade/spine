import { vi } from "vitest";
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

/**
 * In-memory `ipcMain.handle` registry, populated by the mocked `electron` module below. Import this
 * harness (before importing anything that pulls in `electron`) to drive a real `ElectronIpcGateway`
 * headlessly, instead of every consumer re-mocking `electron` itself.
 */
const { ipcRegistry } = vi.hoisted(() => ({
  ipcRegistry: new Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown>
  >(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => Promise<unknown>
    ) => ipcRegistry.set(channel, listener),
  },
}));

/** Simulates `ipcRenderer.invoke(channel, payload)` against the in-memory registry, unwrapping the envelope. */
export async function invokeIpc<T>(
  channel: string,
  payload: unknown
): Promise<T> {
  const listener = ipcRegistry.get(channel);
  if (!listener) throw new Error(`No IPC handler registered for "${channel}".`);
  const envelope = (await listener({}, payload)) as
    | { ok: true; data: T }
    | { ok: false; code: string };
  if (!envelope.ok)
    throw new Error(`Dispatch "${channel}" failed: ${envelope.code}`);
  return envelope.data;
}
