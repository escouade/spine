import { describe, expect, it, vi } from "vitest";
import { Controller, getRoutes } from "@spinejs/gateway-core";
import type {
  ChainInterceptor,
  GatewayContext,
  Guard,
  GuardConstructor,
} from "@spinejs/gateway-core";
import { ElectronIpcGateway } from "./electron-ipc.gateway";
import type { IpcRoute } from "./electron-ipc.gateway";
import { handle } from "./ipc-routes";
import { ZodValidator } from "./zod.validator";
import { DefaultErrorMapper } from "./default-error.mapper";
import type { Logger } from "@spinejs/core";
import type {
  ElectronIpcBaseContext,
  ElectronIpcRaw,
} from "./electron-ipc-base.types";

// Local no-op logger (not `./testing`'s: importing the harness would register a second,
// competing `electron` mock in this file's module graph).
const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;

// Local `electron` mock keeping the RAW listeners: unlike the shared harness's `invokeIpc` (which
// unwraps the envelope and throws on failure), this spec asserts the failure envelope itself.
const { handlers } = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown>
  >(),
}));
vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => Promise<unknown>
    ) => handlers.set(channel, listener),
  },
}));

const contextFactory = {
  create: (raw: ElectronIpcRaw): ElectronIpcBaseContext => ({
    event: raw.event,
  }),
};

const noGuards = new Map<GuardConstructor, Guard<GatewayContext>>();

describe("ElectronIpcGateway failure envelope meta (FailureMeta seam)", () => {
  it("surfaces an interceptor's failure `meta` end-to-end on the IPC envelope", async () => {
    @Controller({})
    class PingController {
      ping = handle("app:ping", {}, () => "pong");
    }

    const rejecting: ChainInterceptor<
      ElectronIpcBaseContext,
      string,
      IpcRoute
    > = {
      intercept: async () => ({
        ok: false,
        code: "TOO_MANY_REQUESTS",
        meta: { retryAfterMs: 750 },
      }),
    };
    const gw = new ElectronIpcGateway(
      new ZodValidator(),
      new DefaultErrorMapper(),
      contextFactory,
      silentLogger,
      [rejecting]
    );
    gw.register(getRoutes(new PingController(), noGuards) as IpcRoute[]);

    const listener = handlers.get("app:ping");
    if (!listener) throw new Error('No IPC handler bound for "app:ping".');
    const envelope = await listener({}, undefined);

    // The renderer receives the semantic meta natively — nothing strips it on the IPC path.
    expect(envelope).toEqual({
      ok: false,
      code: "TOO_MANY_REQUESTS",
      meta: { retryAfterMs: 750 },
    });
  });
});
