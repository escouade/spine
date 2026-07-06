// @spinejs/throttle/http — the HTTP preset (AD-1): the `'ip'` key source (socket address via
// `@hono/node-server`, operator-owned `trustProxy` resolution, IPv4-mapped + NAT64 normalization
// before the IPv6 /56 mask) and the sole outcome→headers translator (draft-6 `RateLimit-*` +
// `Retry-After` through the AD-8 response-headers bag). Optional peers: `@spinejs/http-gateway` +
// `@hono/node-server`.
import { getConnInfo } from "@hono/node-server/conninfo";
import { responseHeadersOf } from "@spinejs/http-gateway";
import type { HttpBaseContext } from "@spinejs/http-gateway";
import type { GatewayContext } from "@spinejs/gateway-core";
import type { ThrottleRouteMeta, ThrottleRouteOption } from "./engine";
import { readThrottleOutcome, type KeySelector } from "./throttle.types";

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

  // The type parameters must repeat the target interface's list verbatim for declaration merging.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface SseRouteOptions<P, Q> {
    /**
     * Rate-limit policy for this SSE stream: the connection attempt is enforced by the throttle
     * interceptor placed in the gateway's `connectInterceptors` slot (AD-6). Same option shape as a
     * verb route — inline `policies`, `skip`, `override`, or `false`. Stream events are never counted.
     */
    throttle?: ThrottleRouteOption | false;
  }
}

/**
 * How the `'ip'` source derives a client address when the app is behind reverse proxies. `undefined`
 * (the default) trusts NO forwarding header — `X-Forwarded-For` is client-controlled, so the direct
 * socket address is used. The two opt-in forms both put the choice in the operator's hands (the lib
 * ships no guessing default that could let a client pick its own key):
 *
 *  - a **positive integer** `N` — the number of trusted proxies that append to `X-Forwarded-For`.
 *    The client is the entry `N` from the RIGHT (`entries[len - N]`): the rightmost `N` entries are
 *    the ones the operator's own proxies wrote, so a client cannot spoof its address by injecting a
 *    leftmost entry. A single nginx in front → `1`; two hops → `2`. Falls back to the socket address
 *    when the header is absent, too short, or the chosen entry is unparseable/`unknown`.
 *  - a **custom extractor** `(ctx) => string | undefined` — pull the address from wherever your
 *    topology carries it (a CDN attribute, a bespoke header); `undefined` falls back to the socket.
 */
export type TrustProxy = number | ((ctx: GatewayContext) => string | undefined);

export interface IpKeySourceOptions {
  /** Proxy-forwarding resolution — OFF by default (direct socket, no header trusted). See {@link TrustProxy}. */
  trustProxy?: TrustProxy;
  /**
   * IPv6 prefix (bits, `[1, 128]`) clients are aggregated on — one /56 is typically one subscriber,
   * so a single household cannot dodge a limit by rotating interface ids. Default 56. IPv4 addresses
   * (including IPv4-mapped and NAT64-embedded IPv4) are NEVER masked.
   */
  ipv6PrefixBits?: number;
}

/**
 * The `'ip'` key source (FR-7): keys a request by its client address, safely.
 *
 * Pipeline (AD-5, order matters): read the address (direct socket via `@hono/node-server`
 * `getConnInfo` by default, or an operator-configured `trustProxy` resolution), then normalize
 * IPv4-mapped IPv6 (`::ffff:a.b.c.d`) and NAT64 (`64:ff9b::a.b.c.d`) to their embedded IPv4
 * **before** any IPv6 masking, then /56-mask real IPv6. Masking a mapped/NAT64 address would
 * collapse every IPv4 client into one key — the express-rate-limit CVE-2026-30827 lesson; the
 * ordering here is regression-guarded by test.
 *
 * An unreadable/unparseable direct socket address throws, following the policy's failure policy
 * (fail-closed by default) — an addressless request never silently bypasses an address-keyed policy.
 * A malformed *forwarded* entry does NOT throw: it falls back to the socket address.
 *
 *   ThrottleModule.configure({
 *     policies: { global: { limit: 100, windowMs: 60_000, keyBy: "ip", scope: "gateway" } },
 *     keySources: { ip: ipKeySource() },
 *   })
 */
export function ipKeySource(options: IpKeySourceOptions = {}): KeySelector {
  const prefixBits = options.ipv6PrefixBits ?? 56;
  if (!Number.isInteger(prefixBits) || prefixBits < 1 || prefixBits > 128) {
    throw new Error(
      `ipKeySource: ipv6PrefixBits must be an integer in [1, 128] (got ${prefixBits}).`
    );
  }
  const trustProxy = options.trustProxy;
  if (
    typeof trustProxy === "number" &&
    (!Number.isInteger(trustProxy) || trustProxy < 1)
  ) {
    throw new Error(
      `ipKeySource: a numeric trustProxy (proxy hop-count) must be a positive integer (got ${trustProxy}).`
    );
  }

  return (ctx: GatewayContext): string => {
    const honoCtx = (ctx as HttpBaseContext).honoCtx;
    if (!honoCtx) {
      throw new Error(
        "ipKeySource: ctx.honoCtx is missing — the 'ip' source only works on the HTTP transport."
      );
    }

    // Resolve a forwarded candidate only when the operator opted into a proxy topology; otherwise
    // the direct socket address is authoritative (no client-controlled header is trusted).
    let candidate: string | undefined;
    if (typeof trustProxy === "function") {
      candidate = trustProxy(ctx) || undefined;
    } else if (typeof trustProxy === "number") {
      candidate = clientFromForwarded(
        honoCtx.req.header("x-forwarded-for"),
        trustProxy
      );
    }

    // Prefer the forwarded candidate, but a malformed/`unknown` forwarded entry must never 429 all
    // proxied traffic — fall back to the direct socket address (the fail-safe default).
    if (candidate !== undefined) {
      const normalized = tryNormalize(candidate, prefixBits);
      if (normalized !== undefined) return normalized;
    }
    const socket = getConnInfo(honoCtx).remote.address;
    if (!socket) {
      throw new Error("ipKeySource: no client address on the connection.");
    }
    return normalizeClientAddress(socket, prefixBits);
  };
}

/**
 * Picks the client entry from an `X-Forwarded-For` header for `hops` trusted proxies: the entry
 * `hops` from the RIGHT (`entries[len - hops]`), with any `host:port` / `[v6]:port` wrapping stripped.
 * Returns `undefined` when the header is absent or shorter than `hops` (→ socket fallback).
 */
function clientFromForwarded(
  header: string | undefined,
  hops: number
): string | undefined {
  if (!header) return undefined;
  const entries = header
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const entry = entries[entries.length - hops];
  return entry === undefined ? undefined : stripPort(entry);
}

/** Strips a trailing `:port` and `[...]` brackets from a forwarded entry (`1.2.3.4:5678`, `[::1]:443`, `[::1]`). */
function stripPort(entry: string): string {
  const bracketed = /^\[(.+?)\](?::\d+)?$/.exec(entry);
  if (bracketed) return bracketed[1];
  // A bare IPv6 has multiple colons; only a `v4:port` (dotted head, single colon) carries a port here.
  const parts = entry.split(":");
  if (parts.length === 2 && parts[0].includes(".")) return parts[0];
  return entry;
}

/** {@link normalizeClientAddress} that returns `undefined` instead of throwing on an unparseable address. */
function tryNormalize(address: string, prefixBits: number): string | undefined {
  try {
    return normalizeClientAddress(address, prefixBits);
  } catch {
    return undefined;
  }
}

/**
 * Normalizes an address into key material (AD-5): IPv4 verbatim; IPv4-mapped IPv6 (`::ffff:a.b.c.d`)
 * and NAT64 (`64:ff9b::a.b.c.d`) unwrapped to their embedded IPv4 FIRST; remaining IPv6 masked to
 * `prefixBits` (rendered as the full 8 hextets plus `/bits`, so distinct prefixes can never collide
 * with an unmasked form).
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
    return embeddedIpv4(hextets);
  }
  // NAT64 well-known prefix 64:ff9b::/96 also embeds an IPv4 in the low 32 bits — unwrap it too,
  // else every NAT64-translated IPv4 client /56-collapses into one key (same class, one prefix over).
  if (
    hextets[0] === 0x0064 &&
    hextets[1] === 0xff9b &&
    hextets[2] === 0 &&
    hextets[3] === 0 &&
    hextets[4] === 0 &&
    hextets[5] === 0
  ) {
    return embeddedIpv4(hextets);
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

/** The dotted IPv4 embedded in the low 32 bits (hextets 6–7) of a mapped/NAT64 address. */
function embeddedIpv4(hextets: number[]): string {
  const [a, b] = [hextets[6] >> 8, hextets[6] & 0xff];
  const [c, d] = [hextets[7] >> 8, hextets[7] & 0xff];
  return `${a}.${b}.${c}.${d}`;
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
 * The sole outcome→headers translator (AD-8): reads the throttle outcome ctx slot the engine wrote
 * (via {@link readThrottleOutcome}) and writes draft-6 quota headers into http-gateway's
 * response-headers bag on BOTH paths — success (`RateLimit-Limit`/`-Remaining`/`-Reset`) and
 * rejection (plus `Retry-After`). The bag is merged into every `bind()` response; no battery code
 * ever builds a `Response`. On by default; `{ enabled: false }` is a real off-switch.
 *
 * Prefer {@link throttleHttp} for one-line wiring; this is the standalone translator for advanced
 * cases (a custom `onOutcome` that also does its own metrics, say).
 */
export function rateLimitHeaders(
  options: RateLimitHeadersOptions = {}
): (ctx: GatewayContext) => void {
  if (options.enabled === false) return () => {};
  return (ctx) => {
    const outcome = readThrottleOutcome(ctx);
    if (!outcome) return; // no policy applied this dispatch — nothing to present
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

/** Options for {@link throttleHttp}: the `'ip'` source tuning plus the header off-switch. */
export interface ThrottleHttpOptions extends IpKeySourceOptions {
  /**
   * Emit draft-6 `RateLimit-*` + `Retry-After` headers. **On by default** once the preset is used;
   * `false` is a real off-switch (FR-12). Presentation lives here on `./http`, never on the core module.
   */
  headers?: boolean;
  /** Extra named key sources wired alongside `'ip'` (merged; `'ip'` wins on a name clash). */
  keySources?: Record<string, KeySelector>;
}

/**
 * One-line HTTP preset wiring for `ThrottleModule.configure` (AD-7/AD-8). Spread it into `configure`
 * and it wires the `'ip'` key source **and** turns on the outcome→headers translator by default —
 * presentation stays on `./http`, never hand-wired on the core module:
 *
 *   ThrottleModule.configure({
 *     policies: { global: { limit: 100, windowMs: 60_000, keyBy: "ip", scope: "gateway" } },
 *     ...throttleHttp(),            // keySources.ip + RateLimit-* and Retry-After headers (on by default)
 *   })
 *
 * `headers: false` is a real off-switch; `trustProxy` / `ipv6PrefixBits` tune the `'ip'` source; extra
 * `keySources` (e.g. `identity`) are merged in.
 */
export function throttleHttp(options: ThrottleHttpOptions = {}): {
  keySources: Record<string, KeySelector>;
  onOutcome?: (ctx: GatewayContext) => void;
} {
  const { headers, keySources, ...ipOptions } = options;
  return {
    keySources: { ...keySources, ip: ipKeySource(ipOptions) },
    ...(headers === false ? {} : { onOutcome: rateLimitHeaders() }),
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
