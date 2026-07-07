// Story 2.2 — boot-time walk of the transport route snapshots (NFR-3 complete). The throttle
// module's start hook walks the wired gateway route snapshot and validates every `meta.throttle`
// spec with the SAME rules as configure-level validation, so a bad route-inline spec fails BOOT with
// the route/channel named — asserted on BOTH transports (HTTP verb helpers + IPC `handle()`).
import "./http"; // loads the http-gateway `throttle` augmentation
import "./electron-ipc"; // loads the electron-ipc-gateway `throttle` augmentation
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Module } from "@spinejs/core";
import type { Logger, ModuleEntry } from "@spinejs/core";
import { Controller, getRoutes } from "@spinejs/gateway-core";
import type {
  Guard,
  GuardConstructor,
  GatewayContext,
} from "@spinejs/gateway-core";
import { post } from "@spinejs/http-gateway";
import { handle } from "@spinejs/electron-ipc-gateway";
import { ThrottleModule } from "./throttle.module";
import type { RouteSnapshot } from "./throttle.module";
import { ThrottleConfigError } from "./policy-validation";
import type { ResolvedThrottleConfig } from "./engine";
import type { ThrottleStore } from "./throttle.types";

// `handle` pulls in `@spinejs/electron-ipc-gateway`'s index, which binds `ipcMain` at import.
vi.mock("electron", () => ({ ipcMain: { handle: () => {} } }));

const noGuards = new Map<GuardConstructor, Guard<GatewayContext>>();
const snapshotOf = (controller: object): RouteSnapshot[] =>
  getRoutes(controller, noGuards).map((r) => ({ meta: r.meta }));

// onStart never touches the store, so a minimal stub is enough (no timers to leak).
const noopStore: ThrottleStore = {
  consume: async () => ({ accepted: true, totalHits: 1, resetMs: 0 }),
};

const makeConfig = (
  overrides: Partial<ResolvedThrottleConfig> = {}
): ResolvedThrottleConfig => ({
  name: "default",
  policies: {},
  keySources: {},
  emitRawKey: false,
  ...overrides,
});

const moduleWalking = (
  snapshot: RouteSnapshot[],
  config = makeConfig()
): ThrottleModule =>
  new ThrottleModule(noopStore, false, config.name, config, () => snapshot);

describe("boot walk of route-inline throttle specs (Story 2.2, NFR-3)", () => {
  it("fails boot on an HTTP verb-helper route with an unwired inline `keyBy` — names the route", () => {
    @Controller({})
    class LoginController {
      login = post(
        "/login",
        { throttle: { policies: [{ limit: 1, windowMs: 1000, keyBy: "ip" }] } },
        () => 0
      );
    }
    const mod = moduleWalking(snapshotOf(new LoginController()));
    expect(() => mod.onStart()).toThrow(ThrottleConfigError);
    expect(() => mod.onStart()).toThrow(
      /POST \/login#0.*keyBy: 'ip'.*not wired/s
    );
  });

  it("fails boot on an IPC `handle()` channel with an unwired inline `keyBy` — names the channel", () => {
    @Controller({})
    class CmdController {
      run = handle(
        "cmd:run",
        { throttle: { policies: [{ limit: 1, windowMs: 1000, keyBy: "ip" }] } },
        () => 0
      );
    }
    const mod = moduleWalking(snapshotOf(new CmdController()));
    expect(() => mod.onStart()).toThrow(ThrottleConfigError);
    expect(() => mod.onStart()).toThrow(/cmd:run#0.*keyBy: 'ip'.*not wired/s);
  });

  it("fails boot on a bad inline `limit` and on `skip`/`override` naming an unknown default", () => {
    @Controller({})
    class BadLimitController {
      r = post(
        "/bad",
        {
          throttle: {
            policies: [{ limit: 0, windowMs: 1000, keyBy: () => "k" }],
          },
        },
        () => 0
      );
    }
    expect(() =>
      moduleWalking(snapshotOf(new BadLimitController())).onStart()
    ).toThrow(/`limit` must be a positive integer/);

    @Controller({})
    class BadSkipController {
      r = post("/skip", { throttle: { skip: ["ghost"] } }, () => 0);
    }
    expect(() =>
      moduleWalking(snapshotOf(new BadSkipController())).onStart()
    ).toThrow(/`skip` names a policy that is not a configured gateway default/);
  });

  it("passes boot for a valid inline spec on both transports (wired source, positive limit)", () => {
    const config = makeConfig({ keySources: { ip: () => "1.2.3.4" } });
    @Controller({})
    class OkHttp {
      r = post(
        "/ok",
        { throttle: { policies: [{ limit: 5, windowMs: 1000, keyBy: "ip" }] } },
        () => 0
      );
    }
    @Controller({})
    class OkIpc {
      r = handle(
        "cmd:ok",
        { throttle: { policies: [{ limit: 5, windowMs: 1000, keyBy: "ip" }] } },
        () => 0
      );
    }
    expect(() =>
      moduleWalking(snapshotOf(new OkHttp()), config).onStart()
    ).not.toThrow();
    expect(() =>
      moduleWalking(snapshotOf(new OkIpc()), config).onStart()
    ).not.toThrow();
  });

  it("walks an empty snapshot without error when no `routes` provider is wired", () => {
    expect(() => moduleWalking([]).onStart()).not.toThrow();
  });
});

// Post-merge review #38: a hand-built or plain-JS `meta.throttle` can carry malformed sub-fields the
// downstream `.forEach` / `for…of` / `Object.entries` would crash on with a raw native `TypeError`.
// The boot walk must reject each with a route-named `ThrottleConfigError` instead. (Three related
// boot-walk findings are deferred to a future framework `MetaValidator` primitive — out of scope here.)
describe("boot walk hardens malformed route-inline `meta.throttle` sub-fields (review #38)", () => {
  const metaSnapshot = (throttle: unknown): RouteSnapshot[] => [
    { meta: { throttle } },
  ];

  it("rejects `policies` that is an object, not an array — names the route (no TypeError)", () => {
    const mod = moduleWalking(
      metaSnapshot({ routeId: "POST /obj-policies", policies: { a: {} } })
    );
    expect(() => mod.onStart()).toThrow(ThrottleConfigError);
    expect(() => mod.onStart()).toThrow(
      /POST \/obj-policies.*policies.*array.*got object/s
    );
  });

  it("rejects `skip` that is a number, not an array — names the route (no TypeError)", () => {
    const mod = moduleWalking(
      metaSnapshot({ routeId: "POST /num-skip", skip: 5 })
    );
    expect(() => mod.onStart()).toThrow(ThrottleConfigError);
    expect(() => mod.onStart()).toThrow(
      /POST \/num-skip.*skip.*array.*got number/s
    );
  });

  it("rejects `skip` array holding a non-string entry — names the route", () => {
    const mod = moduleWalking(
      metaSnapshot({ routeId: "POST /bad-skip-entry", skip: ["ok", 3] })
    );
    expect(() => mod.onStart()).toThrow(ThrottleConfigError);
    expect(() => mod.onStart()).toThrow(
      /POST \/bad-skip-entry.*skip.*policy-name strings.*got number/s
    );
  });

  it("rejects `override` that is a number, not a plain object — names the route (no TypeError)", () => {
    const mod = moduleWalking(
      metaSnapshot({ routeId: "POST /num-override", override: 3 })
    );
    expect(() => mod.onStart()).toThrow(ThrottleConfigError);
    expect(() => mod.onStart()).toThrow(
      /POST \/num-override.*override.*object.*got number/s
    );
  });

  it("rejects an `override` entry that is not a plain object — names the route and entry", () => {
    const mod = moduleWalking(
      metaSnapshot({
        routeId: "POST /bad-override-entry",
        override: { api: 3 },
      })
    );
    expect(() => mod.onStart()).toThrow(ThrottleConfigError);
    expect(() => mod.onStart()).toThrow(
      /POST \/bad-override-entry.*override\.api.*got number/s
    );
  });

  it("rejects `disabled` that is a string, not a boolean — names the route", () => {
    const mod = moduleWalking(
      metaSnapshot({ routeId: "POST /str-disabled", disabled: "true" })
    );
    expect(() => mod.onStart()).toThrow(ThrottleConfigError);
    expect(() => mod.onStart()).toThrow(
      /POST \/str-disabled.*disabled.*boolean.*got string/s
    );
  });

  it("rejects a `policies` entry that is null — names the route + index (no TypeError)", () => {
    const mod = moduleWalking(
      metaSnapshot({ routeId: "POST /null-policy", policies: [null] })
    );
    // Without the entry guard this is a raw `TypeError` on `policy.limit` — the exact symptom the
    // guard exists to kill (review #40).
    expect(() => mod.onStart()).toThrow(ThrottleConfigError);
    expect(() => mod.onStart()).toThrow(
      /POST \/null-policy.*policies\[0\].*policy object.*got null/s
    );
  });

  it("rejects a non-string `routeId` — closes the shared-`route`-bucket footgun (review #40)", () => {
    const mod = moduleWalking(
      metaSnapshot({
        routeId: null,
        policies: [{ limit: 1, windowMs: 1000, keyBy: () => "k" }],
      })
    );
    expect(() => mod.onStart()).toThrow(ThrottleConfigError);
    expect(() => mod.onStart()).toThrow(
      /throttle\.routeId.*non-empty string.*got null/s
    );
  });

  it("rejects `skip: ['constructor']` — a prototype-chain name is not a configured default (review #40)", () => {
    const mod = moduleWalking(
      metaSnapshot({ routeId: "POST /proto-skip", skip: ["constructor"] })
    );
    // `"constructor" in policies` is `true` via the prototype chain; the own-property check keeps it
    // fail-loud instead of silently no-opping the skip.
    expect(() => mod.onStart()).toThrow(ThrottleConfigError);
    expect(() => mod.onStart()).toThrow(
      /constructor.*not a configured gateway default/s
    );
  });

  it("leaves a well-formed inline spec untouched (no false positive)", () => {
    const mod = moduleWalking(
      metaSnapshot({
        routeId: "POST /well-formed",
        policies: [{ limit: 5, windowMs: 1000, keyBy: () => "k" }],
        skip: [],
        override: {},
        disabled: false,
      })
    );
    expect(() => mod.onStart()).not.toThrow();
  });
});

// The start hook fires through a real App boot: a bad route-inline spec rejects `app.start()`.
const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;
const makeApp = (modules: ModuleEntry[]) =>
  new App(modules, { logger: silentLogger, handleProcessExit: false });

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

describe("boot walk fires through a real App start (Story 2.2)", () => {
  it("rejects app.start() when the wired route snapshot carries an invalid inline spec", async () => {
    const badRoute = post(
      "/login",
      { throttle: { policies: [{ limit: 1, windowMs: 1000, keyBy: "ip" }] } },
      () => 0
    );

    @Module({
      imports: [
        ThrottleModule.configure({
          name: "boot-walk-app",
          policies: {},
          routes: { value: () => [{ meta: badRoute.meta }] },
        }),
      ],
    })
    class FeatureModule {}

    const app = makeApp([FeatureModule]);
    await app.init(); // onInit (name claim) succeeds — the spec is only invalid, not the config
    await expect(app.start()).rejects.toThrow(ThrottleConfigError);
    await app.stop().catch(() => {});
  });
});
