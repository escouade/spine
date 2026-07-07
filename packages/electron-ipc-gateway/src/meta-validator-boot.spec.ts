// The IPC gateway module GAINS an `onStart` for the MetaValidator story: it crosses the gateway's own
// channels × its `metaValidators`. A stub validator throwing on a channel fails boot with the CHANNEL
// named (the IPC address IS the routeId); a passing validator lets onStart proceed. Routes are
// hand-built so their `meta` carries the stub's namespace directly.
import { describe, expect, it } from "vitest";
import type { MetaValidator } from "@spinejs/gateway-core";
import { silentLogger } from "./testing"; // also installs the in-memory `electron` mock (vi.hoisted)
import { ElectronIpcGateway } from "./electron-ipc.gateway";
import type { IpcRoute } from "./electron-ipc.gateway";
import { ElectronIpcGatewayModule } from "./electron-ipc-gateway.module";
import { ZodValidator } from "./zod.validator";
import { DefaultErrorMapper } from "./default-error.mapper";
import type {
  ElectronIpcBaseContext,
  ElectronIpcRaw,
} from "./electron-ipc-base.types";

const contextFactory = {
  create: (raw: ElectronIpcRaw): ElectronIpcBaseContext => ({
    event: raw.event,
  }),
};

const route = (channel: string, meta: unknown): IpcRoute => ({
  address: channel,
  guards: [],
  invoke: () => 0,
  meta,
});

const newGateway = (routes: IpcRoute[]): ElectronIpcGateway => {
  const gw = new ElectronIpcGateway(
    new ZodValidator(),
    new DefaultErrorMapper(),
    contextFactory,
    silentLogger
  );
  gw.register(routes);
  return gw;
};

/** A validator that throws on the channel matching `throwOn`. */
const stub = (throwOn: string): MetaValidator & { seen: string[] } => {
  const seen: string[] = [];
  return {
    namespace: "probe",
    seen,
    validate(routeId) {
      seen.push(routeId);
      if (routeId === throwOn) throw new Error(`bad probe on ${routeId}`);
    },
  };
};

const twoChannels = (): IpcRoute[] => [
  route("cmd:ok", { probe: {} }),
  route("cmd:boom", { probe: {} }),
];

describe("ElectronIpcGatewayModule boot walk (metaValidators slot)", () => {
  it("throws from onStart when a validator rejects a channel — the channel is named", () => {
    const gw = newGateway(twoChannels());
    const validator = stub("cmd:boom");
    // Constructor arg order mirrors the @Module inject list: (gateway, metaValidators).
    const mod = new ElectronIpcGatewayModule(gw, [validator]);

    expect(() => mod.onStart()).toThrow(/bad probe on cmd:boom/);
    expect(validator.seen).toContain("cmd:ok");
  });

  it("proceeds through onStart when every validator passes", () => {
    const gw = newGateway(twoChannels());
    const validator = stub("no-match");
    const mod = new ElectronIpcGatewayModule(gw, [validator]);

    expect(() => mod.onStart()).not.toThrow();
    expect(validator.seen).toEqual(["cmd:ok", "cmd:boom"]);
  });

  it("only calls a validator for channels carrying its namespace", () => {
    const gw = newGateway([
      route("cmd:probed", { probe: {} }),
      route("cmd:plain", { other: {} }),
    ]);
    const validator = stub("no-throw");
    new ElectronIpcGatewayModule(gw, [validator]).onStart();
    expect(validator.seen).toEqual(["cmd:probed"]);
  });

  it("does not walk when no validators are wired", () => {
    const gw = newGateway(twoChannels());
    expect(() => new ElectronIpcGatewayModule(gw, []).onStart()).not.toThrow();
  });

  it("configure() accepts a `metaValidators` provider (additive, backward-compatible)", () => {
    const dm = ElectronIpcGatewayModule.configure({
      imports: [],
      contextFactory: { value: contextFactory },
      metaValidators: { value: [stub("none")] },
    });
    expect(dm.module).toBe(ElectronIpcGatewayModule);
  });
});
