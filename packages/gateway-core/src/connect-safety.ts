import type {
  ConnectInterceptor,
  GatewayInterceptor,
  RequestScoped,
} from "./ports";
import type { DispatchTarget, GatewayContext } from "./gateway.types";

/**
 * Capability probe: an interceptor opts into a transport's **connect phase** by exposing an
 * `interceptConnect` method (ADR 0022). Presence — own OR inherited from a connect-capable base — is
 * the opt-in; `typeof` walks the prototype chain, so a subclass that inherits the method is detected
 * exactly like one that declares it. The single source of truth for "connect-capable", used both to
 * derive a connect chain and to guard it ({@link assertConnectInterceptorsSafe}), so the two can never
 * diverge on what counts.
 */
export function isConnectInterceptor<
  Ctx extends GatewayContext = GatewayContext,
  Code extends string = string,
  Target extends DispatchTarget<Ctx> = DispatchTarget<Ctx>
>(
  i: GatewayInterceptor<Ctx, Code, Target>
): i is GatewayInterceptor<Ctx, Code, Target> &
  ConnectInterceptor<Ctx, Code, Target> {
  return (
    typeof (i as Partial<ConnectInterceptor>).interceptConnect === "function"
  );
}

/**
 * Boot guard closing the residual of {@link ConnectInterceptor} (ADR 0022 §Honest framing): the method
 * marker proves *intent to run at connect*, not *connect-safety*. A transport deriving a connect chain
 * calls this at construction, BEFORE the port opens, so a dangerous wiring fails boot instead of leaking
 * at the first stream.
 *
 * Dangerous = an interceptor that is BOTH connect-capable ({@link isConnectInterceptor}) AND declares
 * itself {@link RequestScoped} — it would run at connect and hold a per-request resource (a DB
 * transaction, a CLS scope) open for the connection's whole lifetime. This also catches the inheritance
 * hole (ADR 0022 §Consequences): a `requestScoped` subclass of a connect-capable base inherits BOTH
 * signals, so the probe fires. A connect-safe interceptor (throttle — a shared engine/store, nothing
 * per-request) carries no `requestScoped` marker and passes.
 *
 * The message names the offending interceptor and both fixes (drop `interceptConnect`, or drop the
 * marker if genuinely connect-safe) — a config error, surfaced loudly, never silently.
 */
export function assertConnectInterceptorsSafe(
  interceptors: readonly unknown[]
): void {
  for (const interceptor of interceptors) {
    if (interceptor == null) continue; // a null slot is a wiring error elsewhere, not ours to probe
    if (
      isConnectInterceptor(interceptor as GatewayInterceptor) &&
      (interceptor as Partial<RequestScoped>).requestScoped === true
    ) {
      const ctorName = (interceptor as { constructor?: { name?: string } })
        .constructor?.name;
      // A plain object literal reports `constructor.name === "Object"` — no more identifying than none,
      // so fall back to the generic phrasing there too (a real interceptor is a named class instance).
      const name =
        !ctorName || ctorName === "Object" ? "an interceptor" : ctorName;
      throw new Error(
        `@spinejs/gateway-core: ${name} is marked \`requestScoped\` but also implements ` +
          `ConnectInterceptor (interceptConnect), so it would run at a transport's connection phase ` +
          `(e.g. an SSE connect) and hold a request-scoped resource — a DB transaction, a CLS scope — ` +
          `open for the connection's entire lifetime. A request-scoped interceptor must not run at ` +
          `connect. Remove interceptConnect from ${name}, or drop the requestScoped marker if it is ` +
          `genuinely connect-safe.`
      );
    }
  }
}
