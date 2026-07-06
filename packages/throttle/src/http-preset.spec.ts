import { describe, expect, it } from "vitest";
import { responseHeadersBag } from "@spinejs/http-gateway";
import type { HttpBaseContext, HttpRaw } from "@spinejs/http-gateway";
import type { GatewayContext } from "@spinejs/gateway-core";
import {
  THROTTLE_STATUS_MAPPING,
  ipKeySource,
  normalizeClientAddress,
  rateLimitHeaders,
  throttleHttp,
} from "./http";
import { throttleOutcome, type ThrottleOutcome } from "./throttle.types";

/** Minimal Hono-context stub carrying the socket shape `getConnInfo` reads + a header lookup. */
function httpCtx(
  remoteAddress: string | undefined,
  headers: Record<string, string> = {}
): HttpBaseContext {
  const honoCtx = {
    env: { incoming: { socket: { remoteAddress } } },
    req: { header: (name: string) => headers[name.toLowerCase()] },
  } as unknown as HttpRaw;
  return { honoCtx };
}

describe("'ip' key source — direct socket by default (FR-7, Story 1.9)", () => {
  it("keys by the direct socket address by default", () => {
    expect(ipKeySource()(httpCtx("203.0.113.7"), undefined)).toBe(
      "203.0.113.7"
    );
  });

  it("ignores X-Forwarded-For entirely by default (client-controlled header)", () => {
    const ctx = httpCtx("203.0.113.7", { "x-forwarded-for": "10.0.0.1" });
    expect(ipKeySource()(ctx, undefined)).toBe("203.0.113.7");
  });

  it("throws (→ failure policy, fail-closed default) on a missing or unparseable socket address", () => {
    expect(() => ipKeySource()(httpCtx(undefined), undefined)).toThrow(
      /no client address/
    );
    expect(() => ipKeySource()(httpCtx("not-an-address"), undefined)).toThrow(
      /unparseable/
    );
    expect(() => ipKeySource()({}, undefined)).toThrow(/honoCtx is missing/);
  });
});

describe("'ip' key source — trustProxy resolution (security fix, review PR #36)", () => {
  it("with a hop-count of 1, takes the rightmost XFF entry — a spoofed leftmost is ignored", () => {
    // One trusted proxy (socket) appends the real client as the rightmost entry; the client-injected
    // leftmost `9.9.9.9` must not become the key.
    const ctx = httpCtx("10.0.0.1", {
      "x-forwarded-for": "9.9.9.9, 203.0.113.9",
    });
    expect(ipKeySource({ trustProxy: 1 })(ctx, undefined)).toBe("203.0.113.9");
  });

  it("with a hop-count of N, indexes N from the right (two trusted proxies)", () => {
    const ctx = httpCtx("10.0.0.2", {
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
    });
    expect(ipKeySource({ trustProxy: 2 })(ctx, undefined)).toBe("203.0.113.9");
  });

  it("falls back to the socket when the header is absent or shorter than the hop-count", () => {
    expect(
      ipKeySource({ trustProxy: 1 })(httpCtx("203.0.113.7"), undefined)
    ).toBe("203.0.113.7");
    const short = httpCtx("203.0.113.7", { "x-forwarded-for": "10.0.0.1" });
    expect(ipKeySource({ trustProxy: 2 })(short, undefined)).toBe(
      "203.0.113.7"
    );
  });

  it("strips port / brackets from a forwarded entry (1.2.3.4:5678, [v6]:443)", () => {
    const v4 = httpCtx("10.0.0.1", { "x-forwarded-for": "203.0.113.9:5678" });
    expect(ipKeySource({ trustProxy: 1 })(v4, undefined)).toBe("203.0.113.9");
    const v6 = httpCtx("10.0.0.1", {
      "x-forwarded-for": "[2001:db8:1:200::1]:443",
    });
    expect(ipKeySource({ trustProxy: 1 })(v6, undefined)).toBe(
      "2001:0db8:0001:0200:0000:0000:0000:0000/56"
    );
  });

  it("falls back to the socket on an unparseable / `unknown` forwarded entry (never 429s all traffic)", () => {
    const ctx = httpCtx("203.0.113.7", { "x-forwarded-for": "unknown" });
    expect(ipKeySource({ trustProxy: 1 })(ctx, undefined)).toBe("203.0.113.7");
  });

  it("supports a custom extractor, socket as fallback when it returns undefined", () => {
    const source = ipKeySource({
      trustProxy: (ctx) =>
        (ctx as HttpBaseContext).honoCtx?.req.header("cf-connecting-ip"),
    });
    expect(
      source(
        httpCtx("10.0.0.1", { "cf-connecting-ip": "203.0.113.42" }),
        undefined
      )
    ).toBe("203.0.113.42");
    expect(source(httpCtx("203.0.113.7"), undefined)).toBe("203.0.113.7");
  });

  it("rejects an invalid hop-count or IPv6 prefix at construction (NFR-3)", () => {
    expect(() => ipKeySource({ trustProxy: 0 })).toThrow(/positive integer/);
    expect(() => ipKeySource({ trustProxy: 1.5 })).toThrow(/positive integer/);
    expect(() => ipKeySource({ ipv6PrefixBits: 0 })).toThrow(/\[1, 128\]/);
    expect(() => ipKeySource({ ipv6PrefixBits: 129 })).toThrow(/\[1, 128\]/);
  });
});

describe("'ip' key source — address normalization (AD-5)", () => {
  it("normalizes IPv4-mapped IPv6 BEFORE masking — two IPv4 clients never share a key (CVE-2026-30827 guard)", () => {
    const source = ipKeySource();
    const a = source(httpCtx("::ffff:203.0.113.7"), undefined);
    const b = source(httpCtx("::ffff:203.0.113.8"), undefined);
    expect(a).toBe("203.0.113.7");
    expect(b).toBe("203.0.113.8");
    expect(a).not.toBe(b);
  });

  it("unwraps NAT64 (64:ff9b::/96) embedded IPv4 too — same collapse class, one prefix over", () => {
    const source = ipKeySource();
    const a = source(httpCtx("64:ff9b::203.0.113.7"), undefined);
    const b = source(httpCtx("64:ff9b::203.0.113.8"), undefined);
    expect(a).toBe("203.0.113.7");
    expect(b).toBe("203.0.113.8");
    expect(a).not.toBe(b); // un-normalized /56 masking would collapse both into one key
  });

  it("masks real IPv6 to /56: same subscriber prefix = one key, different prefix = another", () => {
    const source = ipKeySource();
    const sameA = source(httpCtx("2001:db8:1:200::1"), undefined);
    const sameB = source(httpCtx("2001:db8:1:2ff:dead:beef:1:2"), undefined);
    const other = source(httpCtx("2001:db8:1:300::1"), undefined);
    expect(sameA).toBe(sameB);
    expect(sameA).not.toBe(other);
    expect(sameA).toBe("2001:0db8:0001:0200:0000:0000:0000:0000/56");
  });

  it("supports a configurable IPv6 prefix", () => {
    const source = ipKeySource({ ipv6PrefixBits: 64 });
    const a = source(httpCtx("2001:db8:1:201::1"), undefined);
    const b = source(httpCtx("2001:db8:1:202::1"), undefined);
    expect(a).not.toBe(b);
  });

  it("strips IPv6 zone ids before parsing", () => {
    expect(normalizeClientAddress("fe80::1%eth0", 56)).toBe(
      "fe80:0000:0000:0000:0000:0000:0000:0000/56"
    );
  });
});

describe("outcome→headers translator (FR-12, AD-8) — reads the ctx slot", () => {
  const successOutcome: ThrottleOutcome = {
    policyName: "global",
    limit: 100,
    remaining: 42,
    resetMs: 1500,
  };
  const rejectedOutcome: ThrottleOutcome = {
    ...successOutcome,
    remaining: 0,
    retryAfterMs: 2100,
  };
  const ctxWith = (outcome?: ThrottleOutcome): object =>
    outcome === undefined ? {} : { [throttleOutcome]: outcome };
  const bagOf = (ctx: object): Record<string, string> | undefined =>
    (ctx as { [responseHeadersBag]?: Record<string, string> })[
      responseHeadersBag
    ];

  it("writes draft-6 quota headers into the bag on the success path", () => {
    const ctx = ctxWith(successOutcome);
    rateLimitHeaders()(ctx as GatewayContext);
    expect(bagOf(ctx)).toEqual({
      "RateLimit-Limit": "100",
      "RateLimit-Remaining": "42",
      "RateLimit-Reset": "2", // ceil(1500ms → seconds)
    });
  });

  it("adds Retry-After on the rejection path", () => {
    const ctx = ctxWith(rejectedOutcome);
    rateLimitHeaders()(ctx as GatewayContext);
    expect(bagOf(ctx)).toEqual({
      "RateLimit-Limit": "100",
      "RateLimit-Remaining": "0",
      "RateLimit-Reset": "2",
      "Retry-After": "3", // ceil(2100ms → seconds)
    });
  });

  it("does nothing when no outcome slot is present (no policy applied)", () => {
    const ctx = ctxWith(undefined);
    rateLimitHeaders()(ctx as GatewayContext);
    expect(bagOf(ctx)).toBeUndefined();
  });

  it("one preset option disables all header emission", () => {
    const ctx = ctxWith(rejectedOutcome);
    rateLimitHeaders({ enabled: false })(ctx as GatewayContext);
    expect(bagOf(ctx)).toBeUndefined();
  });
});

describe("throttleHttp() one-line wiring (AD-7/AD-8)", () => {
  const bagOf = (ctx: object): Record<string, string> | undefined =>
    (ctx as { [responseHeadersBag]?: Record<string, string> })[
      responseHeadersBag
    ];

  it("wires the 'ip' key source and turns header emission on by default", () => {
    const { keySources, onOutcome } = throttleHttp();
    expect(keySources.ip(httpCtx("203.0.113.7"), undefined)).toBe(
      "203.0.113.7"
    );
    expect(onOutcome).toBeTypeOf("function");

    const ctx = {
      [throttleOutcome]: {
        policyName: "g",
        limit: 5,
        remaining: 2,
        resetMs: 1000,
      },
    };
    onOutcome?.(ctx as GatewayContext);
    expect(bagOf(ctx)).toMatchObject({ "RateLimit-Limit": "5" });
  });

  it("headers:false is a real off-switch (no outcome observer wired)", () => {
    expect(throttleHttp({ headers: false }).onOutcome).toBeUndefined();
  });

  it("merges extra key sources alongside 'ip'", () => {
    const { keySources } = throttleHttp({
      keySources: { identity: () => "user-1" },
    });
    expect(keySources.identity({} as GatewayContext, undefined)).toBe("user-1");
    expect(keySources.ip).toBeTypeOf("function");
  });
});

describe("statusMapper mapping constant (R-8)", () => {
  it("exports the required TOO_MANY_REQUESTS → 429 mapping for custom statusMappers", () => {
    expect(THROTTLE_STATUS_MAPPING).toEqual({ TOO_MANY_REQUESTS: 429 });
  });
});
