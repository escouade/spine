# ADR 0022 — `ConnectInterceptor`: a capability marker for connect-phase enforcement

- **Status**: Accepted
- **Date**: 2026-07-07
- **Scope**: `packages/gateway-core` (`ports.ts` — new `ConnectInterceptor` marker), `packages/http-gateway`
  (`http.gateway.ts` — derive the connect chain; `http-gateway.module.ts` — remove the `connectInterceptors`
  slot), `packages/throttle` (`interceptor.ts` — implement the marker).
- **Relation**: amends [ADR 0017](0017-sse-fan-out-in-http-gateway.md) §3 (the SSE path skips the interceptor
  chain) — a **connect-phase subset** of `interceptors` now runs at connect. Builds on the interceptor port
  of [ADR 0002](0002-gateway-transport-agnostic.md)/[ADR 0005](0005-gateway-composition-http-transport.md).
  Supersedes the interim `connectInterceptors` slot shipped in `@spinejs/http-gateway@0.1.4` (throttle Story 2.3).
- **Reference**: design rationale + prior-art benchmark + three-architect panel in
  `_bmad-output/planning-artifacts/design-sse-connect-enforcement-2026-07-07.md` (Design 4′).

## Context

An SSE endpoint streams for the connection's lifetime and, by [ADR 0017](0017-sse-fan-out-in-http-gateway.md),
**bypasses the buffered `interceptors` pipeline** (a stream is N values, not one `Envelope`). But some
cross-cutting concerns must still act at **connection time**: rate limiting counts one connect as one unit
against the quota. Others must **not**: a request-scoped unit-of-work (`MikroOrmInterceptor`) opening a DB
transaction around a multi-minute stream is a resource leak.

Both live in the same `interceptors: [throttle, uow]` list. The need: run throttle at connect and skip uow —
without forcing the app to wire throttle twice, and without the framework guessing which interceptors are
connect-safe.

The interim answer (Story 2.3, shipped in 0.1.4) was a **second injected slot** `connectInterceptors`: the app
re-declared throttle there. That is double-wiring — omit it and an SSE route _looks_ throttled but streams
unthrottled, with zero diagnostic (a real "F-A" review finding). It also keeps two lists to hold in sync.

## Decision

Replace the second slot with **capability by method presence**, on a **separate marker interface** — Design 4′,
unanimous across a three-architect panel (DX/idiom, correctness, extensibility).

### 1. `ConnectInterceptor` — a phase marker in `gateway-core`, separate from `GatewayInterceptor`

```ts
export interface ConnectInterceptor<
  Ctx = GatewayContext,
  Code = string,
  Target = DispatchTarget<Ctx>
> {
  interceptConnect(
    target,
    ctx,
    rawInput,
    next
  ): Promise<Envelope<unknown, Code>>;
}
```

Kept **off** the shared `GatewayInterceptor` port so that one cross-transport port stays a single method forever.
Each phase a transport adds owns its own marker (a future WebSocket gateway ships its own `WsMessageInterceptor`);
the shared port never accretes streaming-phase methods that IPC-only interceptors would import but never implement.
The signature mirrors `intercept` — there is no distinct connect shape; `next()` resolves to a synthetic accept.

### 2. The HTTP gateway derives the connect chain from the single `interceptors` list

```ts
this.connectInterceptors = interceptors.filter(
  (i): i is GatewayInterceptor & ConnectInterceptor =>
    typeof i.interceptConnect === "function"
); // memoized once in the constructor; registration order preserved
// runConnect: interceptor.interceptConnect(route, ctx, rawInput, next)  — called ON the object (this-safe)
```

One wiring, filtered by capability. `interceptConnect` is invoked as a method on the instance (never a bare
extracted reference), so a `this`-dependent interceptor (throttle reads `this.engine`/`this.store`) can't lose
its receiver and silently fail open.

### 3. Remove the `connectInterceptors` configure slot (breaking)

`HttpGatewayModule.configure({ connectInterceptors })` is deleted. This is a breaking change to
`@spinejs/http-gateway@0.1.4`, taken deliberately: the slot was one day old, had **zero consumers** (not even the
studio), and its only purpose — SSE connect enforcement — is now served with less wiring. App wiring collapses to
one `interceptors` list.

### 4. `throttle` implements both, delegating to a shared core

```ts
class ThrottleInterceptor implements GatewayInterceptor, ConnectInterceptor {
  intercept(t, c, i, next)        { return this.gate(t, c, i, next); }
  interceptConnect(t, c, i, next) { return this.gate(t, c, i, next); } // same engine, same store
  private gate(...) { /* evaluate policies → deny | next() */ }
}
```

A body-method delegating to `gate()`, **not** `interceptConnect = this.intercept` (an unbound function alias
re-introduces the `this`-loss hazard). `MikroOrmInterceptor` implements only `GatewayInterceptor` → it has no
`interceptConnect` → it can never be pulled into the connect chain.

## Honest framing

This is a **safe-default runtime filter**, _not_ "impossible by construction". With one heterogeneous
`interceptors` list (constraint C1), excluding uow is necessarily a runtime `.filter()` — a compile-time type
error would require a second typed slot, which is the very double-wiring we removed. What the marker buys:

- **Safe default** — absent method ⇒ excluded from connect.
- **Highest opt-in friction** — opting in means authoring a whole `interceptConnect` method, review-visible, not
  a one-token flag a copy-paste could set.
- **Claim == behavior** — the connect logic _is_ the method body; there is no metadata that can lie (the failure
  of a `phases: ["connect"]` data-array).

**Residual**: presence proves _intent to run at connect_, not _connect-safety_. Nothing stops a future author
adding `interceptConnect` to a request-scoped interceptor. The type system provably cannot close this (see §Honest
framing); a boot-assert flagging any `requestScoped` interceptor that exposes `interceptConnect` is deferred to the
`MetaValidator` framework story.

## Alternatives considered

- **Separate slot `connectInterceptors` (the interim, ADR-superseded)** — double-wiring; omission is a silent
  unthrottled stream. This ADR removes it.
- **Reuse `interceptors` at connect (`connectInterceptors ?? interceptors`)** — runs uow at connect. The exact
  catastrophe. Rejected.
- **Boolean flag `runsAtConnect`** — a lone flag whose only job is dispatch; not the framework idiom
  (`OnInit`/`OnStart`/`OnStop` are optional-method-by-presence). Rejected.
- **Phase set `phases: ["request","connect"]`** — capability as data that can drift from what `intercept` does;
  introduces a new "capability-as-field" concept absent elsewhere in Spine, and at Spine's ~2 phases the
  N-phase-without-new-methods advantage doesn't pay. Rejected in favor of the marker.
- **`interceptConnect?` optional method ON `GatewayInterceptor`** — same mechanism, but pollutes the shared
  cross-transport port; the next transport forces more optional phase methods onto it. Rejected in favor of a
  separate marker (§1).
- **Prior art**: gRPC-.NET (override the method for the shape you handle) and Kong (optional phase methods) —
  the two frameworks closest to Spine's dispatch model — both land on capability-by-method-presence. NestJS's
  unified `ExecutionContext.getType()` branch is the opt-out default we avoid, because our excluded party (uow)
  fails silently and catastrophically.

## Consequences

- **Positive**: one wiring — an interceptor is enforced at connect iff it implements `ConnectInterceptor`; no
  second list to keep in sync, so the F-A silent-hole class is gone.
- **Positive**: `MikroOrmInterceptor` (and any request-only interceptor) is excluded from connect by construction
  — it cannot be wired into a connect chain it has no method for.
- **Positive**: the shared `GatewayInterceptor` port stays a single method; future phases/transports add their
  own markers without touching it.
- **Positive**: registration order is preserved (the connect chain is a `.filter` of the one ordered list), so no
  second ordering surface to reason about.
- **Negative / breaking**: `HttpGatewayModule.configure({ connectInterceptors })` is removed — a breaking change
  to http-gateway (0.x, zero known consumers; next release notes must call it out).
- **Negative**: connect-only enforcement is no longer a first-class shape. The removed slot could hold an
  interceptor **absent** from `interceptors` (act at connect but not at request, or use distinct connect-vs-request
  instances); now the connect chain is a _subset_ of `interceptors`, so a connect-only interceptor needs a
  pass-through `intercept(t, c, i, next) { return next(); }`. A real narrowing vs the slot — accepted: the case is
  rare and the workaround is one line (documented in `gateway/interceptors.md`).
- **Caution**: the marker proves intent to run at connect, not connect-safety; a request-scoped interceptor that
  wrongly implements `interceptConnect` is still expressible — including via **inheritance** (a subclass of a
  connect-capable base is pulled in silently). Closing that hole is the deferred `MetaValidator` boot-assert.
