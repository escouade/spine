import type { GatewayContext } from "@spinejs/gateway-core";

/**
 * A throttle policy: at most `limit` accepted hits per key inside a sliding `windowMs` window
 * (exact sliding-window-log semantics, AD-4 — a limit means exactly what it says).
 *
 * `keyBy` picks who the key is: the name of a wired key source (`keySources` in
 * `ThrottleModule.configure` — transport presets ship `'ip'` / `'sender'`, `'identity'` is always
 * app-wired) or a custom {@link KeySelector} function.
 */
export interface ThrottlePolicy {
  /** Max accepted hits per key inside the window. Positive, capped by the sanity ceiling (10 000). */
  limit: number;
  /** Sliding window length in milliseconds. Positive. */
  windowMs: number;
  /** Named key source (resolved through `keySources`) or a custom selector function. */
  keyBy: string | KeySelector;
  /**
   * Bucket scope. `'route'` (default): one bucket per key **per route target** (stamped `routeId`).
   * `'gateway'`: one bucket per key shared across every route — declarable ONLY in `configure`
   * (never route-inline, AD-3).
   */
  scope?: "route" | "gateway";
  /**
   * Failure policy for store call failures and throwing selectors: default fail-closed (reject);
   * `true` fails open (the policy is skipped for that request).
   */
  failOpen?: boolean;
  /**
   * Max tracked keys in this policy's isolated key space (LRU-evicted beyond it, evictions never
   * cross policy spaces — AD-5). Defaults to the store's per-policy bound.
   */
  maxKeys?: number;
}

/**
 * Custom key selector: receives the dispatch ctx and the **raw pre-validation input**, returns the
 * key material (normalized string) or `null` to skip the policy for this request. A thrown error
 * follows the policy's failure policy (fail-closed default, per-policy `failOpen`) — same as store
 * errors.
 */
export type KeySelector = (
  ctx: GatewayContext,
  rawInput: unknown
) => string | null;

/** Injectable time source. Monotonic default; every duration derived from it is **relative** ms. */
export interface Clock {
  /** Current time in milliseconds. Monotonic by default — never wall-clock-adjusted. */
  now(): number;
}

/** The slice of a policy a store needs to enforce one `consume` call. */
export interface StorePolicy {
  /** The policy's key-space id: the configured name, or `routeId#index` for route-inline policies. */
  id: string;
  limit: number;
  windowMs: number;
  /** Per-policy key-space bound override (see {@link ThrottlePolicy.maxKeys}). */
  maxKeys?: number;
}

/** Post-decision state of one `consume` call (AD-4). `remaining = limit − totalHits` is derived, never stored. */
export interface ConsumeResult {
  /** Accept → the new in-window count. Reject → exactly `limit`. */
  totalHits: number;
  /** Relative ms until the oldest in-window slot frees (reject → the exact `retryAfterMs`). */
  resetMs: number;
}

/** Per-policy-space introspection counters (FR-14). */
export interface ThrottleStoreStats {
  /** Number of tracked keys in the space. */
  size: number;
  /** Total keys evicted from the space by the max-keys LRU bound. */
  evictions: number;
}

/**
 * Store port (AD-4): **one atomic async call**. Consumption is unconditional — an accepted hit is
 * never refunded, even when another policy rejects the same request. Any implementation (memory,
 * Redis, counter-optimized) must pass the `@spinejs/throttle/testing` contract kit unchanged.
 */
export interface ThrottleStore {
  /**
   * Atomically consume one hit for `key` under `policy` and report the post-decision state.
   * The store never sees raw key material: the engine's key pipeline hashes it first (AD-5).
   */
  consume(key: string, policy: StorePolicy): Promise<ConsumeResult>;
  /** Optional introspection capability: `{ size, evictions }` per policy space (FR-14). */
  stats?(): Record<string, ThrottleStoreStats>;
  /** Optional lifecycle hook: release timers/resources. Called on module stop for owned stores. */
  dispose?(): void;
}

/**
 * Semantic quota state of the **most restrictive** applicable policy (smallest `remaining`,
 * tie-break soonest reset), written once per dispatch under {@link throttleOutcome} (AD-8).
 * Transport-blind — no header names; the `./http` preset is the sole outcome→headers translator.
 */
export interface ThrottleOutcome {
  policyName: string;
  limit: number;
  remaining: number;
  /** Relative ms until the reported policy's oldest slot frees. */
  resetMs: number;
  /** Present on rejection: relative ms after which the client may retry. */
  retryAfterMs?: number;
}

/**
 * **Throttle outcome** ctx symbol (AD-8 — owned by the throttle core). The engine writes it exactly
 * once per dispatch (accept or reject) when at least one policy applied; consumers (the `./http`
 * preset) read it to surface quota state without a second `consume`.
 */
export const throttleOutcome = Symbol("spine.throttle.outcome");

/** Reads the outcome the engine left on a ctx, if any policy applied during dispatch. */
export function readThrottleOutcome(
  ctx: GatewayContext
): ThrottleOutcome | undefined {
  return (ctx as { [throttleOutcome]?: ThrottleOutcome })[throttleOutcome];
}

/** Payload of `onLimitReached` (FR-14). `keyHash` is the stored hash; raw key only on explicit opt-in. */
export interface LimitReachedEvent {
  policyName: string;
  routeId: string;
  /** The hashed key as stored (AD-5) — never the raw key material. */
  keyHash: string;
  retryAfterMs: number;
  /** The raw (pre-hash) key material — present only when `configure({ emitRawKey: true })`. */
  rawKey?: string;
}

/** The stable rejection code an exhausted policy surfaces through the envelope path (FR-11). */
export const TOO_MANY_REQUESTS = "TOO_MANY_REQUESTS" as const;
