# ADR 0024 — Connect-safety boot-assert: a `requestScoped` marker that fails boot on an unsafe connect interceptor

- **Status**: Accepted
- **Date**: 2026-07-07
- **Scope**: `packages/gateway-core` (`ports.ts` — new `RequestScoped` marker; `connect-safety.ts` —
  `isConnectInterceptor` probe + `assertConnectInterceptorsSafe` boot guard), `packages/http-gateway`
  (`http.gateway.ts` — run the guard while deriving the connect chain), `packages/mikro-orm`
  (`mikro-orm.interceptor.ts` — `MikroOrmInterceptor` declares `requestScoped`).
- **Relation**: closes the deferred residual named in [ADR 0022](0022-connect-interceptor-capability-marker.md)
  §Honest framing and §Consequences (the marker proves _intent to run at connect_, not _connect-safety_;
  the inheritance hole). Builds on the SSE connect chain of ADR 0022 / [ADR 0017](0017-sse-fan-out-in-http-gateway.md).

## Context

ADR 0022 runs a **subset** of a gateway's `interceptors` at the SSE connection phase — every interceptor
that implements `ConnectInterceptor` (capability by method presence). That is a safe _default_: a
request-only interceptor omits `interceptConnect` and is excluded from connect by construction, so a
request-scoped unit-of-work (`MikroOrmInterceptor`, which forks a per-request `EntityManager` and holds
its implicit transaction) is never pulled into a multi-minute stream.

ADR 0022 was explicit that this is **not** "impossible by construction". Two residuals remained:

1. **Wrong opt-in** — nothing stops a future author _adding_ `interceptConnect` to a request-scoped
   interceptor. Method presence signals intent to run at connect; it cannot signal that doing so is safe.
2. **Inheritance** — a subclass of a connect-capable base _inherits_ `interceptConnect` silently, so it
   is pulled into the connect chain even though its author never wrote the method.

Both turn a request-scoped resource being held open across a stream into a **silent** leak — no crash, no
diagnostic, just a transaction (or a pooled connection) pinned for the connection's lifetime. The type
system provably cannot forbid it: with one heterogeneous `interceptors` list, exclusion is a runtime
`.filter()`; a compile-time error would require the second typed slot ADR 0022 deliberately removed.

## Decision

Turn the latent leak into a **boot failure** with a self-declared marker plus a transport-side guard.

### 1. `RequestScoped` — a self-declaration marker in `gateway-core`

```ts
export interface RequestScoped {
  readonly requestScoped: true;
}
```

An interceptor that holds a per-request resource declares `readonly requestScoped = true`. This is a
**property of the interceptor**, not a capability that drives dispatch — so, unlike the connect opt-in, a
marker (not a method) is the right shape: there is no method body it would correspond to. The literal
`true` (not `boolean`) means an interceptor either carries the marker or does not; there is no
`requestScoped: false` middle state to reason about. Kept separate from `GatewayInterceptor` for the same
reason `ConnectInterceptor` is: the shared cross-transport port stays a single method.

### 2. `assertConnectInterceptorsSafe` — a boot guard, run where the connect chain is derived

```ts
export function isConnectInterceptor(
  i
): i is GatewayInterceptor & ConnectInterceptor {
  return typeof i.interceptConnect === "function"; // own OR inherited (typeof walks the prototype chain)
}

export function assertConnectInterceptorsSafe(
  interceptors: readonly unknown[]
): void {
  for (const i of interceptors)
    if (i != null && isConnectInterceptor(i) && i.requestScoped === true)
      throw new Error(/* names the interceptor + both fixes */);
}
```

`isConnectInterceptor` is the **single source of truth** for "connect-capable", used both to derive the
connect chain (the HTTP gateway's `.filter(isConnectInterceptor)`) and to guard it — so the two can never
diverge on what counts as connect-capable. Because it probes with `typeof` (prototype-chain aware), the
guard catches the **inheritance** case: a `requestScoped` subclass of a connect-capable base carries both
signals and fails boot.

The HTTP gateway calls the guard in its constructor, **before** deriving `connectInterceptors` and long
before `listen()`, so an unsafe wiring fails at boot — with the offending interceptor named and both fixes
spelled out (remove `interceptConnect`, or drop the marker if genuinely connect-safe) — never as a silent
runtime leak.

### 3. `MikroOrmInterceptor` declares the marker

```ts
export class MikroOrmInterceptor implements GatewayInterceptor, RequestScoped {
  readonly requestScoped = true; // forks a per-request EM → must never run at connect
  // ... no interceptConnect → already excluded from the connect chain (ADR 0022); the marker is the
  //     belt to that suspenders, and closes the inheritance hole for any future subclass.
}
```

Today `MikroOrmInterceptor` has no `interceptConnect`, so it is already excluded from connect. The marker
adds no behavior in the happy path; it exists so that the day someone adds `interceptConnect` (directly or
via a connect-capable base), the gateway refuses to boot instead of leaking.

## Honest framing

This is a **boot-time assertion**, not a type-level proof. It cannot fire for an interceptor the app never
wires, and it trusts the `requestScoped` self-declaration — an author who holds a request-scoped resource
but omits the marker AND adds `interceptConnect` still leaks. What it buys over ADR 0022 alone: the two
realistic mistakes (adding `interceptConnect` to a marked UoW; subclassing a connect-capable base) now
fail loudly at boot with a named, actionable error instead of silently at the first stream. `throttle`
(a shared engine + store, nothing per-request) carries no marker and enforces at connect unaffected — the
marker cleanly separates "runs at connect and that's fine" from "must never run at connect".

## Alternatives considered

- **Do nothing (ship ADR 0022's residual)** — accept a silent transaction leak reachable by a one-line
  mistake. Rejected: the failure mode is invisible and catastrophic (a pinned DB connection per stream).
- **A `phases`/`connectSafe: boolean` data field** — capability/safety as data that can drift from what the
  interceptor actually does; the same "capability-as-field" concept ADR 0022 rejected for the connect
  opt-in. The marker mirrors the framework's optional-method/marker idiom instead.
- **Type-level exclusion (a second typed connect slot)** — would make the leak a compile error, but
  re-introduces the double-wiring ADR 0022 removed (the silent-unthrottled-stream class F-A). Rejected;
  the boot-assert keeps the single `interceptors` list.
- **Guard only the derived connect chain, not the full list** — equivalent here (the dangerous set is
  exactly `requestScoped ∧ connect-capable`), but scanning the full list keeps the guard self-contained
  and reusable by a future transport (a WebSocket gateway) that derives its own phase chain.

## Consequences

- **Positive**: the ADR 0022 residual is closed for the two realistic paths — a marked request-scoped
  interceptor that gains `interceptConnect`, directly or by inheritance, fails boot with a named error.
- **Positive**: `isConnectInterceptor` centralizes the connect-capability probe; the gateway's chain
  derivation and the safety guard share one definition and cannot diverge.
- **Positive**: zero happy-path cost — the guard is one boot-time scan; a correctly wired app (throttle
  connect-capable + UoW request-scoped) passes untouched.
- **Neutral**: `RequestScoped` is a new public export of `gateway-core`; other request-scoped interceptors
  (e.g. a future one holding a per-request lease) should declare it too to benefit from the guard.
- **Negative**: it remains a runtime assertion trusting self-declaration — an author who both omits the
  marker and adds `interceptConnect` to a request-scoped interceptor is still unguarded. Accepted: the
  type system cannot close this without the double-wiring ADR 0022 removed (see §Honest framing).
