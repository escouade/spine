import type {
  ConnectInterceptor,
  Envelope,
  GatewayContext,
  GatewayInterceptor,
} from "@spinejs/gateway-core";
import { ThrottleEngine } from "./engine";
import type { ResolvedThrottleConfig } from "./engine";
import type { ThrottleStore } from "./throttle.types";

/**
 * The gateway-facing enforcement point: a transport-agnostic interceptor the app places **first**
 * (outermost) in a gateway's `interceptors`. It also implements {@link ConnectInterceptor}, so the
 * same instance is picked up by the HTTP gateway's SSE connect chain — one connection counts against
 * the same quota (one instance = one engine = one store, AD-6). No second wiring: declaring
 * `interceptConnect` IS the opt-in.
 *
 * Outermost placement is what makes rejected requests cheap (FR-9): the engine short-circuits
 * before any guard, validation or handler work — and BECAUSE enforcement precedes validation,
 * invalid requests still count and an over-limit invalid request 429s, never 400s.
 *
 * Typed on the base `GatewayInterceptor` (ctx/next only, route meta read opaquely), so it drops
 * into any transport's narrowed `ChainInterceptor` slot without a cast.
 */
export class ThrottleInterceptor
  implements GatewayInterceptor, ConnectInterceptor
{
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
    return this.gate(target, ctx, rawInput, next);
  }

  /**
   * SSE connect enforcement (Design 4′): the SAME logic as {@link intercept}, exposed as the
   * `ConnectInterceptor` phase entry so the HTTP gateway runs this instance at connection time. The
   * connection is one unit against the quota; stream events are never counted (the connect chain runs
   * exactly once). Declaring this method is the opt-in — a request-only interceptor omits it.
   */
  async interceptConnect(
    target: unknown,
    ctx: GatewayContext,
    rawInput: unknown,
    next: () => Promise<Envelope<unknown, string>>
  ): Promise<Envelope<unknown, string>> {
    return this.gate(target, ctx, rawInput, next);
  }

  /** Shared enforcement core for both phases: evaluate the route's policies, deny or pass through. */
  private async gate(
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
