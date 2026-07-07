import type { MetaValidator } from "@spinejs/gateway-core";
import { validateRouteThrottleMeta } from "./engine";
import type { ResolvedThrottleConfig } from "./engine";

/**
 * The throttle battery's `MetaValidator` (namespace `"throttle"`). Wired into a gateway's
 * `metaValidators` slot, it validates every route's `meta.throttle` spec at boot with the SAME rules
 * as `configure`-level validation (NFR-3) — a bad inline `keyBy`, a `skip`/`override` naming an unknown
 * default, an exotic `override` value, a malformed `keyBy` all fail boot with the route named, never
 * the first dispatch. The gateway that holds this validator is the gateway that enforces throttling, so
 * the validated routes are exactly the enforced routes (closes review findings F-B/F-C).
 */
export class ThrottleMetaValidator implements MetaValidator {
  readonly namespace = "throttle";

  constructor(private readonly config: ResolvedThrottleConfig) {}

  /**
   * The gateway walk hands us the ALREADY-unwrapped `meta.throttle` slice, but
   * `validateRouteThrottleMeta` reads the full route `meta` and unwraps `.throttle` itself — so re-wrap
   * as `{ throttle: meta }`. The route id is already stamped inside the spec (`meta.throttle.routeId`),
   * so `validateRouteThrottleMeta` names the route itself; the generic `routeId` param is redundant here
   * but required by the {@link MetaValidator} interface.
   */
  validate(_routeId: string, meta: unknown): void {
    validateRouteThrottleMeta(
      { throttle: meta },
      this.config.policies,
      this.config.keySources
    );
  }
}
