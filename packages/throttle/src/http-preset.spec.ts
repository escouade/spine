import { describe, expect, it } from "vitest";
import { responseHeadersBag } from "@spinejs/http-gateway";
import type { HttpBaseContext, HttpRaw } from "@spinejs/http-gateway";
import {
  THROTTLE_STATUS_MAPPING,
  ipKeySource,
  normalizeClientAddress,
  rateLimitHeaders,
} from "./http";
import type { ThrottleOutcome } from "./throttle.types";

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

describe("'ip' key source (FR-7, Story 1.9)", () => {
  it("keys by the direct socket address by default", () => {
    expect(ipKeySource()(httpCtx("203.0.113.7"), undefined)).toBe(
      "203.0.113.7"
    );
  });

  it("ignores X-Forwarded-For unless trustProxy is enabled (client-controlled header)", () => {
    const ctx = httpCtx("203.0.113.7", { "x-forwarded-for": "10.0.0.1" });
    expect(ipKeySource()(ctx, undefined)).toBe("203.0.113.7");
  });

  it("honors the leftmost X-Forwarded-For entry with trustProxy, socket as fallback", () => {
    const proxied = httpCtx("127.0.0.1", {
      "x-forwarded-for": "198.51.100.9, 10.0.0.1",
    });
    expect(ipKeySource({ trustProxy: true })(proxied, undefined)).toBe(
      "198.51.100.9"
    );
    // No forwarding header → the socket address.
    expect(
      ipKeySource({ trustProxy: true })(httpCtx("203.0.113.7"), undefined)
    ).toBe("203.0.113.7");
  });

  it("normalizes IPv4-mapped IPv6 BEFORE masking — two IPv4 clients never share a key (CVE-2026-30827 guard)", () => {
    const source = ipKeySource();
    const a = source(httpCtx("::ffff:203.0.113.7"), undefined);
    const b = source(httpCtx("::ffff:203.0.113.8"), undefined);
    // Un-normalized masking at /56 would zero the whole v4 tail and collapse a and b into one key.
    expect(a).toBe("203.0.113.7");
    expect(b).toBe("203.0.113.8");
    expect(a).not.toBe(b);
  });

  it("masks real IPv6 to /56: same subscriber prefix = one key, different prefix = another", () => {
    const source = ipKeySource();
    const sameA = source(httpCtx("2001:db8:1:200::1"), undefined);
    const sameB = source(httpCtx("2001:db8:1:2ff:dead:beef:1:2"), undefined);
    const other = source(httpCtx("2001:db8:1:300::1"), undefined);
    expect(sameA).toBe(sameB); // both inside 2001:db8:1:200::/56
    expect(sameA).not.toBe(other);
    expect(sameA).toBe("2001:0db8:0001:0200:0000:0000:0000:0000/56");
  });

  it("supports a configurable IPv6 prefix", () => {
    const source = ipKeySource({ ipv6PrefixBits: 64 });
    const a = source(httpCtx("2001:db8:1:201::1"), undefined);
    const b = source(httpCtx("2001:db8:1:202::1"), undefined);
    expect(a).not.toBe(b); // distinct /64s stay distinct when masking at 64 bits
  });

  it("throws (→ failure policy, fail-closed default) on a missing or unparseable address", () => {
    expect(() => ipKeySource()(httpCtx(undefined), undefined)).toThrow(
      /no client address/
    );
    expect(() => ipKeySource()(httpCtx("not-an-address"), undefined)).toThrow(
      /unparseable/
    );
    expect(() => ipKeySource()({}, undefined)).toThrow(/honoCtx is missing/);
  });

  it("strips IPv6 zone ids before parsing", () => {
    expect(normalizeClientAddress("fe80::1%eth0", 56)).toBe(
      "fe80:0000:0000:0000:0000:0000:0000:0000/56"
    );
  });
});

describe("outcome→headers translator (FR-12, AD-8)", () => {
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
  const bagOf = (ctx: object): Record<string, string> | undefined =>
    (ctx as { [responseHeadersBag]?: Record<string, string> })[
      responseHeadersBag
    ];

  it("writes draft-6 quota headers into the bag on the success path", () => {
    const ctx = {};
    rateLimitHeaders()(ctx, successOutcome);
    expect(bagOf(ctx)).toEqual({
      "RateLimit-Limit": "100",
      "RateLimit-Remaining": "42",
      "RateLimit-Reset": "2", // ceil(1500ms → seconds)
    });
  });

  it("adds Retry-After on the rejection path", () => {
    const ctx = {};
    rateLimitHeaders()(ctx, rejectedOutcome);
    expect(bagOf(ctx)).toEqual({
      "RateLimit-Limit": "100",
      "RateLimit-Remaining": "0",
      "RateLimit-Reset": "2",
      "Retry-After": "3", // ceil(2100ms → seconds)
    });
  });

  it("one preset option disables all header emission", () => {
    const ctx = {};
    rateLimitHeaders({ enabled: false })(ctx, rejectedOutcome);
    expect(bagOf(ctx)).toBeUndefined();
  });
});

describe("statusMapper mapping constant (R-8)", () => {
  it("exports the required TOO_MANY_REQUESTS → 429 mapping for custom statusMappers", () => {
    expect(THROTTLE_STATUS_MAPPING).toEqual({ TOO_MANY_REQUESTS: 429 });
  });
});
