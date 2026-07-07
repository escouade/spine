import type { MetaValidator } from "./ports";

/**
 * The pure boot-time walk a transport runs at start: for every route whose opaque `meta` carries a
 * validator's `namespace`, hand that validator the route's namespaced slice and let it throw on an
 * invalid spec (a route-named config error → boot fails before the port opens). Each transport calls
 * this with its own `address → routeId` fn, so the crossing logic lives once, not per transport.
 *
 * Backward-compatible by construction: zero validators wired → no walk at all; a route with no `meta`
 * (or a non-object `meta`), or one that simply doesn't carry a given namespace as an OWN key, is
 * skipped. A `namespace` key set to `undefined` is treated as absent (not "present but invalid").
 */
export function validateRouteMeta<Addr>(
  routes: readonly { address: Addr; meta?: unknown }[],
  validators: readonly MetaValidator[],
  addressToRouteId: (address: Addr) => string
): void {
  if (validators.length === 0) return; // no validators → no crossing (zero-overhead default)
  for (const route of routes) {
    const meta = route.meta;
    if (meta == null || typeof meta !== "object") continue;
    const rec = meta as Record<string, unknown>;
    for (const v of validators) {
      // Own-property check, not a bare `rec[ns]`: a validator whose `namespace` is an `Object.prototype`
      // member ("toString"/"constructor") would otherwise inherit a truthy value from the prototype
      // chain and fire on EVERY route — the same proto-chain class the throttle engine guards.
      if (
        Object.prototype.hasOwnProperty.call(rec, v.namespace) &&
        rec[v.namespace] !== undefined
      ) {
        v.validate(addressToRouteId(route.address), rec[v.namespace]);
      }
    }
  }
}
