# ADR 0025 — HTTP app-level middleware hook (`configure({ middleware })`)

- **Status**: Accepted
- **Date**: 2026-07-07
- **Scope**: `packages/http-gateway` (`http.gateway.ts` — a `middleware` constructor arg mounted before
  any route binds; `http-gateway.module.ts` — a `middleware` configure option + DI slot).
- **Relation**: complements the interceptor pipeline of [ADR 0002](0002-gateway-transport-agnostic.md) /
  [ADR 0005](0005-gateway-composition-http-transport.md). Interceptors are the transport-agnostic,
  per-dispatch concern (they see the `Envelope`, not the raw HTTP); this hook is for **HTTP-native**
  middleware (helmet, compression, CORS) that must act on the raw Hono request/response.

## Context

The HTTP gateway is a Hono app. Cross-cutting HTTP concerns — security headers, gzip, CORS preflight —
are Hono middleware, mounted with `app.use()`. But **Hono applies a middleware only to routes registered
after it**: `app.use(mw)` must run before `app.on(method, path, …)` for that route, or the middleware
silently never fires.

Routes are bound during feature modules' `onInit` (the synthesized `gateway.register()` call). So an app
that wanted middleware had only one avenue (documented in the README): build the `HttpGateway` itself in
its composition root, call `app.use(...)` before registration, and pass it via `configure({ gateway })`.
That works but forces the whole custom-gateway path for the common case, and the "before registration"
ordering constraint is easy to get wrong (mount middleware in a module `onStart` and it races — or loses
— route binding that already happened in `onInit`).

## Decision

Add a first-class `middleware` option to `HttpGatewayModule.configure`, mounted **in the `HttpGateway`
constructor**, before any route is bound.

```ts
HttpGatewayModule.configure({
  imports: [...],
  contextFactory: { value: myContextFactory },
  middleware: { value: [secureHeaders(), compress(), cors()] }, // outermost-first
});
```

- **The constructor is the deterministic mount point.** DI constructs the gateway _before_ feature
  modules' `onInit` run (they inject it to call `register()`), so mounting middleware in the ctor
  guarantees it precedes every route binding — no lifecycle race, no "did onStart run before or after
  register" reasoning. The Hono `app` is still empty at that point, so array order = middleware nesting
  order (first = outermost).
- **A plain provider slot**, mirroring `interceptors` / `metaValidators` (`ProviderAdapter<MiddlewareHandler[]>`,
  default `[]`). Additive and backward-compatible: omit it and nothing changes.
- **Applies to the DEFAULT gateway only.** When the app passes a pre-built `gateway`, it owns its Hono
  setup and mounts middleware itself — the option is ignored there, exactly like `contextFactory`.

### Middleware vs interceptors

Kept distinct on purpose. Interceptors are transport-agnostic and see the dispatch `Envelope`; they run
for IPC too and cannot touch raw HTTP framing. Middleware is Hono-typed (`MiddlewareHandler`), wraps the
raw request/response (headers, status, short-circuit), and is HTTP-only. A concern that belongs to HTTP
plumbing (security headers, compression) is middleware; a concern about the dispatch (auth context, rate
limiting, CLS) is an interceptor.

## Consequences

- **Positive**: the common case (add helmet/compression/CORS) is one option, no custom-gateway ceremony,
  and the ordering constraint is enforced structurally (ctor-time) instead of by documentation.
- **Positive**: order is explicit and deterministic — the array is the middleware stack, outermost-first,
  and it always precedes route binding.
- **Neutral**: `middleware` mounts globally (`app.use(mw)`, all paths), so it also wraps SSE routes —
  a response-buffering middleware (`compress()`) would break a stream. Path-scoped middleware
  (`app.use(path, mw)`) — including scoping buffering middleware away from SSE — still needs the pre-built
  `gateway` path — an intentional simplicity trade for the 90% case; both documented.
- **Guard**: `configure({ gateway, middleware })` (both) throws — a pre-built gateway replaces the factory
  that reads the middleware slot, so the option would be silently dropped. Failing loudly mirrors the
  existing `gateway`-XOR-`contextFactory` validation.
- **Negative / breaking**: none. The `HttpGateway` constructor gains a trailing optional arg (`middleware`,
  default `[]`); existing positional constructions are unaffected.
