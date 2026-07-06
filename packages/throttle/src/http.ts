// @spinejs/throttle/http — the HTTP preset (AD-1): the `'ip'` key source (socket address via
// `@hono/node-server`, `trustProxy` option, IPv4-mapped normalization before the IPv6 /56 mask) and
// the sole outcome→headers translator (draft-6 `RateLimit-*` + `Retry-After` through the AD-8
// response-headers bag). Optional peers: `@spinejs/http-gateway` + `@hono/node-server`.
import { getConnInfo } from "@hono/node-server/conninfo";
import { responseHeadersOf } from "@spinejs/http-gateway";
import type { HttpBaseContext } from "@spinejs/http-gateway";
import type { GatewayContext } from "@spinejs/gateway-core";
import type { ThrottleRouteMeta, ThrottleRouteOption } from "./engine";
import type { KeySelector, ThrottleOutcome } from "./throttle.types";

/**
 * Route-option typing for HTTP apps (AD-3): importing anything from `@spinejs/throttle/http` makes
 * `throttle` a fully-typed option of every verb helper. Without the battery, writing `throttle:`
 * in route options is a TS error (unknown property) — the transport carries no battery vocabulary.
 */
declare module "@spinejs/http-gateway" {
  // The type parameters must repeat the target interface's list verbatim for declaration merging.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface RouteOptions<P, Q, B> {
    /**
     * Rate-limit policy for this route: inline `policies` (scoped `routeId#index`,
     * non-overridable), `skip` named gateway defaults, `override` them per-route — or `false` to
     * opt out of every default. Enforced by `@spinejs/throttle`'s interceptor.
     */
    throttle?: ThrottleRouteOption | false;
  }

  interface HttpRouteMeta {
    /** The stamped `meta.throttle` copy (user fields verbatim + `routeId`) — see AD-3. */
    throttle?: ThrottleRouteMeta;
  }
}

export interface IpKeySourceOptions {
  /**
   * Trust the `X-Forwarded-For` header (leftmost entry) when present. OFF by default: the header
   * is client-controlled — enable it only behind a proxy you operate. The direct socket address
   * is always the fallback.
   */
  trustProxy?: boolean;
  /**
   * IPv6 prefix (bits) clients are aggregated on — one /56 is typically one subscriber, so a
   * single household cannot dodge a limit by rotating interface ids. Default 56. IPv4 addresses
   * (including IPv4-mapped IPv6) are NEVER masked.
   */
  ipv6PrefixBits?: number;
}

/**
 * The `'ip'` key source (FR-7): keys a request by its client address, safely.
 *
 * Pipeline (AD-5, order matters): read the address (direct socket via `@hono/node-server`
 * `getConnInfo`, or leftmost `X-Forwarded-For` with `trustProxy`), then normalize IPv4-mapped IPv6
 * (`::ffff:a.b.c.d` → `a.b.c.d`) **before** any IPv6 masking, then /56-mask real IPv6. Masking a
 * mapped address would collapse every IPv4 client into one key — the express-rate-limit
 * CVE-2026-30827 lesson; the ordering here is regression-guarded by test.
 *
 * An unreadable/unparseable address throws, following the policy's failure policy (fail-closed by
 * default) — an addressless request never silently bypasses an address-keyed policy.
 *
 *   ThrottleModule.configure({
 *     policies: { global: { limit: 100, windowMs: 60_000, keyBy: "ip", scope: "gateway" } },
 *     keySources: { ip: ipKeySource() },
 *   })
 */
export function ipKeySource(options: IpKeySourceOptions = {}): KeySelector {
  const prefixBits = options.ipv6PrefixBits ?? 56;
  return (ctx: GatewayContext): string => {
    const honoCtx = (ctx as HttpBaseContext).honoCtx;
    if (!honoCtx) {
      throw new Error(
        "ipKeySource: ctx.honoCtx is missing — the 'ip' source only works on the HTTP transport."
      );
    }
    let address: string | undefined;
    if (options.trustProxy) {
      const forwarded = honoCtx.req.header("x-forwarded-for");
      address = forwarded?.split(",")[0]?.trim() || undefined;
    }
    address ??= getConnInfo(honoCtx).remote.address;
    if (!address) {
      throw new Error("ipKeySource: no client address on the connection.");
    }
    return normalizeClientAddress(address, prefixBits);
  };
}

/**
 * Normalizes an address into key material (AD-5): IPv4 verbatim; IPv4-mapped IPv6 unwrapped to its
 * IPv4 form FIRST; remaining IPv6 masked to `prefixBits` (rendered as the full 8 hextets plus
 * `/bits`, so distinct prefixes can never collide with an unmasked form).
 */
export function normalizeClientAddress(
  address: string,
  prefixBits: number
): string {
  const trimmed = address.trim().replace(/%.*$/, ""); // strip any zone id
  if (isIpv4(trimmed)) return trimmed;

  const hextets = parseIpv6(trimmed);
  if (hextets === undefined) {
    throw new Error(`ipKeySource: unparseable client address "${address}".`);
  }
  // IPv4-mapped (::ffff:a.b.c.d) → the embedded IPv4, BEFORE any masking (CVE-2026-30827).
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    const [a, b] = [hextets[6] >> 8, hextets[6] & 0xff];
    const [c, d] = [hextets[7] >> 8, hextets[7] & 0xff];
    return `${a}.${b}.${c}.${d}`;
  }
  // Real IPv6: zero every bit beyond the prefix.
  const masked = hextets.map((hextet, index) => {
    const bitOffset = index * 16;
    if (bitOffset + 16 <= prefixBits) return hextet;
    if (bitOffset >= prefixBits) return 0;
    return hextet & (0xffff << (16 - (prefixBits - bitOffset)));
  });
  const rendered = masked
    .map((hextet) => hextet.toString(16).padStart(4, "0"))
    .join(":");
  return `${rendered}/${prefixBits}`;
}

/** Strict dotted-quad check (the shapes node's `remoteAddress` / XFF entries produce). */
function isIpv4(address: string): boolean {
  const parts = address.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** Parses IPv6 (incl. `::` compression and a dotted IPv4 tail) into 8 hextets, or undefined. */
function parseIpv6(address: string): number[] | undefined {
  let head = address;
  // Fold a dotted IPv4 tail (e.g. ::ffff:1.2.3.4) into two trailing hextets.
  const tail: number[] = [];
  const lastColon = address.lastIndexOf(":");
  const maybeV4 = address.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    if (!isIpv4(maybeV4)) return undefined;
    const bytes = maybeV4.split(".").map(Number);
    tail.push((bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]);
    head = address.slice(0, lastColon + 1) + "0:0"; // placeholder, replaced below
  }

  const groups = head.split("::");
  if (groups.length > 2) return undefined;
  const parseGroups = (part: string): number[] | undefined => {
    if (part === "") return [];
    const out: number[] = [];
    for (const raw of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(raw)) return undefined;
      out.push(parseInt(raw, 16));
    }
    return out;
  };
  const left = parseGroups(groups[0]);
  const right = groups.length === 2 ? parseGroups(groups[1]) : [];
  if (left === undefined || right === undefined) return undefined;

  let hextets: number[];
  if (groups.length === 2) {
    const fill = 8 - left.length - right.length;
    if (fill < 0) return undefined;
    hextets = [...left, ...Array<number>(fill).fill(0), ...right];
  } else {
    hextets = left;
  }
  if (hextets.length !== 8) return undefined;
  if (tail.length === 2) hextets.splice(6, 2, ...tail);
  return hextets;
}

export interface RateLimitHeadersOptions {
  /** Single off-switch (FR-12): `false` disables ALL header emission from this translator. */
  enabled?: boolean;
}

/**
 * The sole outcome→headers translator (AD-8): plugs into `ThrottleModule.configure({ onOutcome })`
 * and writes draft-6 quota headers into http-gateway's response-headers bag on BOTH paths —
 * success (`RateLimit-Limit`/`-Remaining`/`-Reset`) and rejection (plus `Retry-After`). The bag is
 * merged into every `bind()` response; no battery code ever builds a `Response`.
 *
 *   ThrottleModule.configure({ ..., onOutcome: rateLimitHeaders() })
 */
export function rateLimitHeaders(
  options: RateLimitHeadersOptions = {}
): (ctx: GatewayContext, outcome: ThrottleOutcome) => void {
  if (options.enabled === false) return () => {};
  return (ctx, outcome) => {
    const bag = responseHeadersOf(ctx);
    bag["RateLimit-Limit"] = String(outcome.limit);
    bag["RateLimit-Remaining"] = String(outcome.remaining);
    // Draft-6 headers carry delta-seconds; the semantic outcome stays in ms.
    bag["RateLimit-Reset"] = String(Math.ceil(outcome.resetMs / 1000));
    if (outcome.retryAfterMs !== undefined) {
      bag["Retry-After"] = String(Math.ceil(outcome.retryAfterMs / 1000));
    }
  };
}

/**
 * The status mapping a custom http-gateway `statusMapper` MUST carry for throttling to surface
 * correctly (R-8). The default mapper already includes it; spread this constant into a custom one:
 *
 *   statusMapper: { value: (code) => ({ ...THROTTLE_STATUS_MAPPING, NOT_FOUND: 404 }[code] ?? 500) }
 */
export const THROTTLE_STATUS_MAPPING = {
  TOO_MANY_REQUESTS: 429,
} as const;
