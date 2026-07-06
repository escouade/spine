import type {
  Envelope,
  GatewayContext,
  GatewayInterceptor,
} from "@spinejs/gateway-core";
import type {
  KeySelector,
  LimitReachedEvent,
  ThrottleOutcome,
  ThrottlePolicy,
  ThrottleStore,
} from "./throttle.types";

/** One `configure()` call's fully-resolved, validated configuration — never merged across instances (AD-7). */
export interface ResolvedThrottleConfig {
  /** Instance name (`configure({ name })`), `"default"` when omitted. */
  name: string;
  /** Gateway-default policies, keyed by their configured (unique) name. */
  policies: Record<string, ThrottlePolicy>;
  /** Wired named key sources a string `keyBy` resolves through. */
  keySources: Record<string, KeySelector>;
  /** Observability hook fired on every rejection (FR-14). */
  onLimitReached?: (event: LimitReachedEvent) => void;
  /** Opt-in: include the raw (pre-hash) key on `onLimitReached` events. */
  emitRawKey: boolean;
  /** Outcome observer (AD-8) — the `./http` preset plugs its outcome→headers translator here. */
  onOutcome?: (ctx: GatewayContext, outcome: ThrottleOutcome) => void;
}

/**
 * The gateway-facing enforcement point: a transport-agnostic `ChainInterceptor` the app places
 * **first** (outermost) in a gateway's `interceptors` — and, for SSE connect enforcement (Epic 2),
 * the same instance in `connectInterceptors`. One instance = one engine = one store (AD-6).
 *
 * Typed on the base `GatewayInterceptor` (ctx/next only, route read opaquely), so it drops into any
 * transport's narrowed `ChainInterceptor` slot without a cast.
 */
export class ThrottleInterceptor implements GatewayInterceptor {
  constructor(
    /** This instance's resolved configuration (readonly — instances never share or merge config). */
    readonly config: ResolvedThrottleConfig,
    /** The store backing this instance's policies, when one is wired. */
    readonly store: ThrottleStore | undefined
  ) {}

  // Policy evaluation (engine) lands with Story 1.7 — until then the interceptor is a pass-through
  // shell, so Story 1.3's module wiring (token exposure, named-instance isolation) ships green.
  intercept(
    _target: unknown,
    _ctx: GatewayContext,
    _rawInput: unknown,
    next: () => Promise<Envelope<unknown, string>>
  ): Promise<Envelope<unknown, string>> {
    return next();
  }
}
