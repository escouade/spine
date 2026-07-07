// MetaValidator story — boot-time validation of route-inline `meta.throttle` specs now runs through
// the gateway `metaValidators` slot (the throttle `ThrottleMetaValidator`), NOT the removed
// `ThrottleModule.configure({ routes })` walk. The gateway crosses its own routes × its own validators:
// the validated routes are exactly the enforced routes (closes review F-B/F-C). Every malformed-meta
// case from the #38/#40 hardening set is preserved, plus the AC8 fail-silent findings, plus the
// per-instance isolation guarantee (F-C), plus a real App start through `HttpGatewayModule.configure`.
import "./http"; // loads the http-gateway `throttle` augmentation
import "./electron-ipc"; // loads the electron-ipc-gateway `throttle` augmentation
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, Module } from "@spinejs/core";
import type { Logger, ModuleEntry } from "@spinejs/core";
import {
  Controller,
  getRoutes,
  validateRouteMeta,
} from "@spinejs/gateway-core";
import type {
  Guard,
  GuardConstructor,
  GatewayContext,
} from "@spinejs/gateway-core";
import { HttpGatewayModule, httpFeature, post } from "@spinejs/http-gateway";
import type { HttpRaw } from "@spinejs/http-gateway";
import {
  ElectronIpcGatewayModule,
  handle,
  ipcFeature,
} from "@spinejs/electron-ipc-gateway";
import type {
  ElectronIpcBaseContext,
  ElectronIpcRaw,
} from "@spinejs/electron-ipc-gateway";
import { ThrottleModule, throttleMetaValidatorRef } from "./throttle.module";
import { ThrottleMetaValidator } from "./meta-validator";
import { ThrottleConfigError } from "./policy-validation";
import type { ResolvedThrottleConfig } from "./engine";

// `handle` pulls in `@spinejs/electron-ipc-gateway`'s index, which binds `ipcMain` at import.
vi.mock("electron", () => ({ ipcMain: { handle: () => {} } }));

const noGuards = new Map<GuardConstructor, Guard<GatewayContext>>();

const makeConfig = (
  overrides: Partial<ResolvedThrottleConfig> = {}
): ResolvedThrottleConfig => ({
  name: "default",
  policies: {},
  keySources: {},
  emitRawKey: false,
  ...overrides,
});

// Mirror the gateway boot walk EXACTLY: cross a controller's real routes × [ThrottleMetaValidator], as
// HttpGatewayModule/ElectronIpcGatewayModule do in their onStart. The address doubles as the walk's
// routeId; the throttle error still names the route from the stamped `meta.throttle.routeId`.
const walkController = (controller: object, config = makeConfig()): void => {
  const routes = getRoutes(controller, noGuards);
  validateRouteMeta(routes, [new ThrottleMetaValidator(config)], (a) =>
    typeof a === "string" ? a : `${a.method} ${a.path}`
  );
};

// Cross a single hand-built route whose `meta.throttle` is the given (possibly malformed) value.
const walkMeta = (throttle: unknown, config = makeConfig()): void => {
  validateRouteMeta(
    [{ address: "probe", meta: { throttle } }],
    [new ThrottleMetaValidator(config)],
    (a) => a
  );
};

describe("throttle MetaValidator validates route-inline specs at boot (via the gateway walk)", () => {
  it("fails boot on an HTTP verb-helper route with an unwired inline `keyBy` — names the route", () => {
    @Controller({})
    class LoginController {
      login = post(
        "/login",
        { throttle: { policies: [{ limit: 1, windowMs: 1000, keyBy: "ip" }] } },
        () => 0
      );
    }
    expect(() => walkController(new LoginController())).toThrow(
      ThrottleConfigError
    );
    expect(() => walkController(new LoginController())).toThrow(
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
    expect(() => walkController(new CmdController())).toThrow(
      /cmd:run#0.*keyBy: 'ip'.*not wired/s
    );
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
    expect(() => walkController(new BadLimitController())).toThrow(
      /`limit` must be a positive integer/
    );

    @Controller({})
    class BadSkipController {
      r = post("/skip", { throttle: { skip: ["ghost"] } }, () => 0);
    }
    expect(() => walkController(new BadSkipController())).toThrow(
      /`skip` names a policy that is not a configured gateway default/
    );
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
    expect(() => walkController(new OkHttp(), config)).not.toThrow();
    expect(() => walkController(new OkIpc(), config)).not.toThrow();
  });

  it("walks a route with no `meta.throttle` without error", () => {
    @Controller({})
    class Plain {
      r = post("/plain", {}, () => 0);
    }
    expect(() => walkController(new Plain())).not.toThrow();
  });
});

// #38/#40 — a hand-built or plain-JS `meta.throttle` can carry malformed sub-fields the downstream
// `.forEach` / `for…of` / `Object.entries` would crash on with a raw native `TypeError`. The validator
// rejects each with a route-named `ThrottleConfigError` instead.
describe("throttle MetaValidator hardens malformed route-inline `meta.throttle` sub-fields (#38/#40)", () => {
  it("rejects `policies` that is an object, not an array — names the route (no TypeError)", () => {
    expect(() =>
      walkMeta({ routeId: "POST /obj-policies", policies: { a: {} } })
    ).toThrow(/POST \/obj-policies.*policies.*array.*got object/s);
  });

  it("rejects `skip` that is a number, not an array — names the route (no TypeError)", () => {
    expect(() => walkMeta({ routeId: "POST /num-skip", skip: 5 })).toThrow(
      /POST \/num-skip.*skip.*array.*got number/s
    );
  });

  it("rejects `skip` array holding a non-string entry — names the route", () => {
    expect(() =>
      walkMeta({ routeId: "POST /bad-skip-entry", skip: ["ok", 3] })
    ).toThrow(/POST \/bad-skip-entry.*skip.*policy-name strings.*got number/s);
  });

  it("rejects `override` that is a number, not a plain object — names the route (no TypeError)", () => {
    expect(() =>
      walkMeta({ routeId: "POST /num-override", override: 3 })
    ).toThrow(/POST \/num-override.*override.*object.*got number/s);
  });

  it("rejects an `override` entry that is not a plain object — names the route and entry", () => {
    expect(() =>
      walkMeta({ routeId: "POST /bad-override-entry", override: { api: 3 } })
    ).toThrow(/POST \/bad-override-entry.*override\.api.*got number/s);
  });

  it("rejects `disabled` that is a string, not a boolean — names the route", () => {
    expect(() =>
      walkMeta({ routeId: "POST /str-disabled", disabled: "true" })
    ).toThrow(/POST \/str-disabled.*disabled.*boolean.*got string/s);
  });

  it("rejects a `policies` entry that is null — names the route + index (no TypeError)", () => {
    expect(() =>
      walkMeta({ routeId: "POST /null-policy", policies: [null] })
    ).toThrow(/POST \/null-policy.*policies\[0\].*policy object.*got null/s);
  });

  it("rejects a non-string `routeId` — closes the shared-`route`-bucket footgun (#40)", () => {
    expect(() =>
      walkMeta({
        routeId: null,
        policies: [{ limit: 1, windowMs: 1000, keyBy: () => "k" }],
      })
    ).toThrow(/throttle\.routeId.*non-empty string.*got null/s);
  });

  it("rejects `skip: ['constructor']` — a prototype-chain name is not a configured default (#40)", () => {
    expect(() =>
      walkMeta({ routeId: "POST /proto-skip", skip: ["constructor"] })
    ).toThrow(/constructor.*not a configured gateway default/s);
  });

  it("rejects `override: { constructor: … }` — a prototype-chain name is not a configured default (#40)", () => {
    expect(() =>
      walkMeta({
        routeId: "POST /proto-override",
        override: {
          constructor: { limit: 5, windowMs: 1000, keyBy: () => "k" },
        },
      })
    ).toThrow(/constructor.*not a configured gateway default/s);
  });

  it("leaves a well-formed inline spec untouched (no false positive)", () => {
    expect(() =>
      walkMeta({
        routeId: "POST /well-formed",
        policies: [{ limit: 5, windowMs: 1000, keyBy: () => "k" }],
        skip: [],
        override: {},
        disabled: false,
      })
    ).not.toThrow();
  });
});

// AC8 — the two #40 fail-silent findings the validator now owns.
describe("throttle MetaValidator rejects fail-silent specs at boot (AC8)", () => {
  // A route-scoped default named `api`, so an `override: { api: … }` reaches the entry-shape check.
  const withApiDefault = makeConfig({
    policies: { api: { limit: 5, windowMs: 1000, keyBy: () => "k" } },
  });

  it("rejects an `override` value that is exotic-but-`typeof==='object'` (Date/Map/RegExp) — it would spread to nothing", () => {
    for (const [exotic, name] of [
      [new Date(), "Date"],
      [new Map(), "Map"],
      [/re/, "RegExp"],
    ] as const) {
      expect(() =>
        walkMeta(
          { routeId: "POST /exotic", override: { api: exotic } },
          withApiDefault
        )
      ).toThrow(ThrottleConfigError);
      expect(() =>
        walkMeta(
          { routeId: "POST /exotic", override: { api: exotic } },
          withApiDefault
        )
      ).toThrow(new RegExp(`override\\.api.*plain object.*got ${name}`, "s"));
    }
  });

  it("rejects an `override` MAP that is exotic-but-`typeof==='object'` (Date/Map) — `Object.entries` would drop every override", () => {
    // An exotic `override` container yields no own enumerable keys, so `Object.entries` is `[]` and
    // EVERY override is silently dropped — the same fail-silent class as an exotic entry, one level up.
    for (const [exotic, name] of [
      [new Map([["api", { limit: 5 }]]), "Map"],
      [new Date(), "Date"],
    ] as const) {
      expect(() =>
        walkMeta(
          { routeId: "POST /exotic-map", override: exotic },
          withApiDefault
        )
      ).toThrow(ThrottleConfigError);
      expect(() =>
        walkMeta(
          { routeId: "POST /exotic-map", override: exotic },
          withApiDefault
        )
      ).toThrow(
        new RegExp(`throttle\\.override.*plain object.*got ${name}`, "s")
      );
    }
  });

  it("still ACCEPTS a legitimate empty `override: { api: {} }` and an `Object.create(null)` value", () => {
    expect(() =>
      walkMeta(
        { routeId: "POST /empty-ov", override: { api: {} } },
        withApiDefault
      )
    ).not.toThrow();
    expect(() =>
      walkMeta(
        { routeId: "POST /null-proto", override: { api: Object.create(null) } },
        withApiDefault
      )
    ).not.toThrow();
  });

  it("rejects an inline `keyBy` that is neither a string nor a function — names the policy (fails boot, not closed at request)", () => {
    expect(() =>
      walkMeta({
        routeId: "POST /num-keyby",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        policies: [{ limit: 1, windowMs: 1000, keyBy: 5 as any }],
      })
    ).toThrow(
      /POST \/num-keyby#0.*keyBy.*name \(string\) or a selector function.*got number/s
    );
  });

  it("rejects an inline policy with a MISSING `keyBy` — undefined can be neither looked up nor called", () => {
    expect(() =>
      walkMeta({
        routeId: "POST /no-keyby",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        policies: [{ limit: 1, windowMs: 1000 } as any],
      })
    ).toThrow(/POST \/no-keyby#0.*keyBy.*got undefined/s);
  });
});

// F-C — per-instance isolation. Each battery instance's validator only knows its OWN policies, so it
// never raises a false `skip`/`override` failure against another instance's policies. The gateway owns
// both halves (its routes + its validators), so a validator can only ever see its own gateway's routes.
describe("throttle MetaValidator is per-instance isolated (F-C — no cross-instance false positive)", () => {
  const routePolicy = () => ({
    limit: 5,
    windowMs: 1000,
    keyBy: () => "k",
    scope: "route" as const,
  });

  it("a route that `skip`s instance A's default passes A's validator but fails B's (each sees only its own policies)", () => {
    const vA = new ThrottleMetaValidator(
      makeConfig({ name: "a", policies: { a: routePolicy() } })
    );
    const vB = new ThrottleMetaValidator(
      makeConfig({ name: "b", policies: { b: routePolicy() } })
    );
    const routeSkippingA = { routeId: "POST /a", skip: ["a"] };

    // A knows `a` → the skip is legitimate. B does not → it would (correctly) reject it. Because the
    // gateway crosses its OWN routes × its OWN validator, only A ever validates A's routes.
    expect(() => vA.validate("POST /a", routeSkippingA)).not.toThrow();
    expect(() => vB.validate("POST /a", routeSkippingA)).toThrow(
      /`skip` names a policy that is not a configured gateway default/
    );
  });
});

// The gateway boot walk fires through a real App start: a bad route-inline spec on the gateway that
// HOLDS the throttle validator rejects `app.start()` (before the port opens). Restore process signal
// handlers App installs at construction (core app.spec pattern).
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ControllerClass = new (...args: any[]) => object;

const httpAppModule = (
  name: string,
  controllers: ControllerClass[]
): ModuleEntry => {
  @Module({
    imports: [
      HttpGatewayModule.configure({
        imports: [ThrottleModule.configure({ name, policies: {} })],
        contextFactory: {
          factory: () => ({ create: (c: HttpRaw) => ({ honoCtx: c }) }),
        },
        // The throttle validator is placed on the SAME gateway that holds the routes → validated
        // routes == enforced routes (F-B closed by construction).
        metaValidators: {
          inject: [throttleMetaValidatorRef(name)] as const,
          factory: (v: ThrottleMetaValidator) => [v],
        },
      }),
      httpFeature({ controllers }),
    ],
  })
  class TestAppModule {}
  return TestAppModule;
};

describe("gateway boot walk fires through a real App start (metaValidators slot)", () => {
  it("rejects app.start() when a route on the enforcing gateway carries an invalid inline spec", async () => {
    @Controller({})
    class BadController {
      login = post(
        "/login",
        { throttle: { policies: [{ limit: 1, windowMs: 1000, keyBy: "ip" }] } },
        () => 0
      );
    }
    const app = makeApp([httpAppModule("real-boot-bad", [BadController])]);
    await app.init(); // onInit (name claim + route registration) succeeds — the spec is only invalid
    await expect(app.start()).rejects.toThrow(ThrottleConfigError);
    await app.stop().catch(() => {});
  });

  it("starts cleanly when the inline spec on the enforcing gateway is valid", async () => {
    @Controller({})
    class OkController {
      ping = post(
        "/ping",
        {
          throttle: {
            policies: [{ limit: 5, windowMs: 1000, keyBy: () => "k" }],
          },
        },
        () => 0
      );
    }
    const app = makeApp([httpAppModule("real-boot-ok", [OkController])]);
    await app.init();
    await expect(app.start()).resolves.toBeUndefined();
    await app.stop().catch(() => {});
  });
});

const ipcAppModule = (
  name: string,
  controllers: ControllerClass[]
): ModuleEntry => {
  @Module({
    imports: [
      ElectronIpcGatewayModule.configure({
        imports: [ThrottleModule.configure({ name, policies: {} })],
        contextFactory: {
          factory: () => ({
            create: (raw: ElectronIpcRaw): ElectronIpcBaseContext => ({
              event: raw.event,
            }),
          }),
        },
        // Same wiring as HTTP: the validator sits on the gateway that holds the channels. The IPC
        // module's new onStart runs the walk (there is no listen) — a bad channel meta rejects boot.
        metaValidators: {
          inject: [throttleMetaValidatorRef(name)] as const,
          factory: (v: ThrottleMetaValidator) => [v],
        },
      }),
      ipcFeature({ controllers }),
    ],
  })
  class TestIpcAppModule {}
  return TestIpcAppModule;
};

describe("IPC gateway boot walk fires through a real App start (metaValidators slot)", () => {
  it("rejects app.start() when a channel on the enforcing gateway carries an invalid inline spec — names the channel", async () => {
    @Controller({})
    class BadIpcController {
      run = handle(
        "cmd:run",
        { throttle: { policies: [{ limit: 1, windowMs: 1000, keyBy: "ip" }] } },
        () => 0
      );
    }
    const app = makeApp([
      ipcAppModule("real-boot-ipc-bad", [BadIpcController]),
    ]);
    await app.init(); // onInit (name claim + channel registration) succeeds — the spec is only invalid
    // Start once; assert both the type and the channel-named message on the same rejection.
    const err = await app
      .start()
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ThrottleConfigError);
    expect((err as Error).message).toMatch(
      /cmd:run#0.*keyBy: 'ip'.*not wired/s
    );
    await app.stop().catch(() => {});
  });
});
