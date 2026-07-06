import type {
  Envelope,
  GatewayContext,
  GatewayInterceptor,
} from "@spinejs/gateway-core";
import { ThrottleEngine } from "./engine";
import type { ResolvedThrottleConfig } from "./engine";
import type { ThrottleStore } from "./throttle.types";

/**
 * The gateway-facing enforcement point: a transport-agnostic `ChainInterceptor` the app places
 * **first** (outermost) in a gateway's `interceptors` — and, for SSE connect enforcement (Epic 2),
 * the same instance in `connectInterceptors`. One instance = one engine = one store (AD-6).
 *
 * Outermost placement is what makes rejected requests cheap (FR-9): the engine short-circuits
 * before any guard, validation or handler work — and BECAUSE enforcement precedes validation,
 * invalid requests still count and an over-limit invalid request 429s, never 400s.
 *
 * Typed on the base `GatewayInterceptor` (ctx/next only, route meta read opaquely), so it drops
 * into any transport's narrowed `ChainInterceptor` slot without a cast.
 */
export class ThrottleInterceptor implements GatewayInterceptor {
  private readonly engine: ThrottleEngine;

  constructor(
    /** This instance's resolved configuration (readonly — instances never share or merge config). */
    readonly config: ResolvedThrottleConfig,
    /** The store backing this instance's policies. */
    readonly store: ThrottleStore
  ) {
    this.engine = new ThrottleEngine(config, store);
  }

  async intercept(
    target: unknown,
    ctx: GatewayContext,
    rawInput: unknown,
    next: () => Promise<Envelope<unknown, string>>
  ): Promise<Envelope<unknown, string>> {
    // The route's opaque `meta` (AD-3): present on a LoadedRoute, absent on a bare DispatchTarget.
    const meta = (target as { meta?: unknown } | null)?.meta;
    const rejection = await this.engine.evaluate(meta, ctx, rawInput);
    if (rejection) return rejection; // short-circuit: no guard/validator/handler work (FR-9)
    return next();
  }
}
