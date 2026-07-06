// Story 1.10 — HTTP end-to-end through a REAL App boot: DI-provided interceptor (outermost),
// gateway-wide per-IP quota + a bruteforce login policy (identity from payload + address, UC-1/2),
// injected clock, real Hono dispatch (`gateway.app.request` with a socket-shaped env for
// `getConnInfo`). Deterministic across runs (NFR-5).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App, Module } from "@spinejs/core";
import type { Logger, ModuleEntry } from "@spinejs/core";
import { Controller } from "@spinejs/gateway-core";
import {
  HttpGateway,
  HttpGatewayModule,
  get,
  httpFeature,
  post,
} from "@spinejs/http-gateway";
import type { HttpRaw } from "@spinejs/http-gateway";
import { z } from "zod";
import { ThrottleModule, throttleInterceptorRef } from "./throttle.module";
import type { ThrottleInterceptor } from "./interceptor";
import { ThrottleConfigError } from "./policy-validation";
import { ipKeySource, throttleHttp } from "./http";
import { FakeClock } from "./testing";
import type { GatewayContext } from "@spinejs/gateway-core";

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;

// App installs process-level error handlers at construction; snapshot + restore (core app.spec pattern).
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

/** Identity + address pairing (UC-2, the docs' null-skip-safe bruteforce key). */
const identityAndIp = (ctx: GatewayContext, rawInput: unknown): string => {
  const email = (rawInput as { body?: { email?: string } })?.body?.email ?? "";
  return `${email}|${ipKeySource()(ctx, rawInput)}`;
};

@Controller({})
class ApiController {
  ping = get("/ping", {}, () => "pong");
  login = post(
    "/login",
    {
      // The email is normalized (trim + lowercase) BY VALIDATION — so the bruteforce selector, which
      // runs before validation, keys on the raw casing (UC-2 security, pinned below).
      body: z.object({
        email: z.string().trim().toLowerCase(),
        password: z.string(),
      }),
      throttle: {
        policies: [{ limit: 2, windowMs: 60_000, keyBy: identityAndIp }],
      },
    },
    () => "welcome"
  );
}

interface Harness {
  app: App;
  gateway: HttpGateway;
  clock: FakeClock;
  request: (
    path: string,
    init?: RequestInit,
    address?: string
  ) => Promise<Response>;
}

async function bootApp(): Promise<Harness> {
  const clock = new FakeClock();
  let gateway: HttpGateway | undefined;

  @Module({
    inject: [HttpGateway] as const,
    imports: [
      HttpGatewayModule.configure({
        imports: [
          ThrottleModule.configure({
            policies: {
              global: {
                limit: 5,
                windowMs: 60_000,
                keyBy: "ip",
                scope: "gateway",
              },
            },
            // One-line HTTP preset wiring: 'ip' key source + RateLimit-*/Retry-After headers on by
            // default (no hand-wired onOutcome — presentation lives on ./http, AD-7/AD-8).
            ...throttleHttp(),
            clock,
          }),
        ],
        contextFactory: {
          factory: () => ({ create: (c: HttpRaw) => ({ honoCtx: c }) }),
        },
        // Outermost slot: rejected requests shed before guards/validation (FR-9).
        interceptors: {
          inject: [throttleInterceptorRef()] as const,
          factory: (throttle: ThrottleInterceptor) => [throttle],
        },
      }),
      httpFeature({ controllers: [ApiController] }),
    ],
  })
  class TestAppModule {
    constructor(gw: HttpGateway) {
      gateway = gw;
    }
  }

  const modules: ModuleEntry[] = [TestAppModule];
  const app = new App(modules, {
    logger: silentLogger,
    handleProcessExit: false,
  });
  await app.init();
  if (!gateway) throw new Error("HttpGateway was not resolved");
  const gw = gateway;
  return {
    app,
    gateway: gw,
    clock,
    // `getConnInfo` reads `env.incoming.socket` — hand app.request a socket-shaped env.
    request: (path, init, address = "203.0.113.7") =>
      gw.app.request(path, init, {
        incoming: { socket: { remoteAddress: address } },
      }),
  };
}

const loginBody = (email: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, password: "hunter2" }),
});

describe("HTTP e2e (Story 1.10, UC-1/UC-2)", () => {
  it("rejects exactly at limit+1 in a cold window, with 429 + Retry-After and success-path quota headers before it", async () => {
    const { app, request } = await bootApp();
    try {
      for (let i = 0; i < 5; i++) {
        const res = await request("/ping");
        expect(res.status).toBe(200);
        // Success-path draft-6 headers (FR-12): remaining decreases 4 → 0.
        expect(res.headers.get("RateLimit-Limit")).toBe("5");
        expect(res.headers.get("RateLimit-Remaining")).toBe(String(4 - i));
        expect(res.headers.get("RateLimit-Reset")).toBe("60");
        expect(res.headers.get("Retry-After")).toBeNull();
      }

      const rejected = await request("/ping"); // limit + 1
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get("Retry-After")).toBe("60");
      expect(rejected.headers.get("RateLimit-Remaining")).toBe("0");
      expect(await rejected.json()).toEqual({
        ok: false,
        code: "TOO_MANY_REQUESTS",
        meta: { retryAfterMs: 60_000 },
      });
    } finally {
      await app.stop();
    }
  });

  it("keeps per-IP buckets separate on the gateway-wide policy", async () => {
    const { app, request } = await bootApp();
    try {
      for (let i = 0; i < 5; i++) await request("/ping", undefined, "10.0.0.1");
      expect((await request("/ping", undefined, "10.0.0.1")).status).toBe(429);
      // Another client is untouched.
      expect((await request("/ping", undefined, "10.0.0.2")).status).toBe(200);
    } finally {
      await app.stop();
    }
  });

  it("enforces the login route-inline bruteforce policy on identity+address (UC-2)", async () => {
    const { app, request } = await bootApp();
    try {
      // Two attempts allowed for alice from this address…
      expect((await request("/login", loginBody("alice"))).status).toBe(200);
      expect((await request("/login", loginBody("alice"))).status).toBe(200);
      // …the third is rejected by the route policy (global quota still has room: 5 > 3).
      const rejected = await request("/login", loginBody("alice"));
      expect(rejected.status).toBe(429);
      expect(rejected.headers.get("Retry-After")).toBe("60");
      // A different identity from the same address still passes (per-identity bucket).
      expect((await request("/login", loginBody("bob"))).status).toBe(200);
    } finally {
      await app.stop();
    }
  });

  it("keys the bruteforce bucket on the RAW email, before validation trims/lowercases it (UC-2 security)", async () => {
    const { app, request } = await bootApp();
    try {
      // Exhaust the two-attempt limit for the exact raw casing "Alice@x.y".
      expect((await request("/login", loginBody("Alice@x.y"))).status).toBe(
        200
      );
      expect((await request("/login", loginBody("Alice@x.y"))).status).toBe(
        200
      );
      expect((await request("/login", loginBody("Alice@x.y"))).status).toBe(
        429
      );
      // A different RAW casing normalizes to the SAME account post-validation ("alice@x.y"), yet keys
      // a DIFFERENT throttle bucket — the selector ran on un-normalized input. Were selection to move
      // after validation, this request would collide with the exhausted bucket and 429.
      expect((await request("/login", loginBody("  alice@x.y  "))).status).toBe(
        200
      );
    } finally {
      await app.stop();
    }
  });

  it("429-before-400: an over-limit request is rejected before validation (invalid body still counts)", async () => {
    const { app, request } = await bootApp();
    try {
      const invalid: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nope: true }),
      };
      // Invalid bodies consume quota (enforcement precedes validation)…
      expect((await request("/login", invalid)).status).toBe(400);
      expect((await request("/login", invalid)).status).toBe(400);
      // …and once over limit, the rejection is a 429, not a 400.
      expect((await request("/login", invalid)).status).toBe(429);
    } finally {
      await app.stop();
    }
  });

  it("replays the scripted sequence identically across two fresh apps (NFR-5)", async () => {
    const run = async (): Promise<(number | string | null)[]> => {
      const { app, clock, request } = await bootApp();
      try {
        const trace: (number | string | null)[] = [];
        for (const [path, step] of [
          ["/ping", 0],
          ["/ping", 100],
          ["/ping", 100],
          ["/ping", 100],
          ["/ping", 100],
          ["/ping", 100],
          ["/ping", 30_000],
        ] as const) {
          clock.tick(step);
          const res = await request(path);
          trace.push(res.status, res.headers.get("RateLimit-Remaining"));
        }
        return trace;
      } finally {
        await app.stop();
      }
    };

    expect(await run()).toEqual(await run());
  });

  it("fails at boot on the HTTP transport for an invalid configuration (NFR-3)", () => {
    expect(() =>
      HttpGatewayModule.configure({
        imports: [
          ThrottleModule.configure({
            policies: { bad: { limit: 0, windowMs: 1000, keyBy: "ip" } },
            keySources: { ip: ipKeySource() },
          }),
        ],
        contextFactory: {
          factory: () => ({ create: (c: HttpRaw) => ({ honoCtx: c }) }),
        },
      })
    ).toThrow(ThrottleConfigError);
  });
});
