# ADR 0005 — Gateway as composable helpers (`DispatchPipeline`) + the HTTP transport

- **Status**: Accepted
- **Date**: 2026-07-01
- **Scope**: `packages/gateway`, `packages/http-gateway`, `packages/electron-ipc-gateway`
- **Relation**: supersedes the **inheritance mechanism** of [ADR 0002](./0002-gateway-transport-agnostic.md) (the abstract `Gateway` base class). Keeps everything else of ADR 0002 (the 3-layer split, DI-injectable guards, the ports). Sibling of [ADR 0004](./0004-field-form-routes.md).

## Context

ADR 0002 made the gateway transport-agnostic via an **abstract base class**: `Gateway<Ctx, Code>` owned the `guards → validate → invoke → envelope` pipeline, and each transport **extended** it and implemented `bind()`. Adding the HTTP transport (Hono) exposed the limits of that inheritance model:

- A transport that extends `Gateway` inherits a fixed `register`/`dispatch` shape and a single `Addr` type parameter baked into the base. HTTP's address is `{ method, path }`, IPC's is a `string` channel — modelling both through one inherited base meant threading `Addr` through the base and casting at every call site.
- The base coupled "the pipeline" (pure, testable) with "being a gateway" (a class you must subclass). A transport could not **hold** a pipeline and keep its own class shape; it had to _be_ a subclass.
- Each transport module re-declared the same `toProvider` adapter helper to wire its ports without repeating the internal token.

## Decision

### 1. The pipeline is a composable helper, not a base class

`Gateway` (abstract) is deleted. The cross-transport core lives in `DispatchPipeline<Ctx, Code>`:

```typescript
class DispatchPipeline<
  Ctx extends GatewayContext,
  Code extends string = string
> {
  constructor(
    validator: Validator,
    errorMapper: ErrorMapper<Code>,
    interceptors?: GatewayInterceptor<Ctx, Code>[]
  ) {}
  dispatch(
    target: DispatchTarget<Ctx>,
    ctx: Ctx,
    rawInput: unknown
  ): Promise<Envelope<unknown, Code>>;
}
```

A transport **holds** a pipeline and calls `dispatch()` from its own listener. It owns `register`/`bind`, address extraction, context building and emitting the envelope. `ElectronIpcGateway` and `HttpGateway` both compose a `DispatchPipeline` instead of extending a base.

### 2. Address-free target vs loaded route

The pipeline consumes a `DispatchTarget<Ctx>` (`guards` + optional `input` + `invoke`) — **no address**. The loader's output is a `LoadedRoute<Ctx, Addr>` that extends `DispatchTarget` with the transport's own `address` and opaque `meta`. Each transport binds `Addr` to its own model (HTTP `{ method, path }`, IPC `string`) without a shared base forcing one. `RouteDescriptor` (ADR 0002's name) is replaced by this `DispatchTarget` / `LoadedRoute` pair.

### 3. `toProvider` / `ProviderAdapter` in the gateway core

The per-transport `configure()` adapter helper is mutualised in `@spinejs/gateway-core`: `ProviderAdapter<T>` is `Omit<FactoryProvider<T> | ValueProvider<T>, "provide">` (derived from the core provider shapes), and `toProvider(token, adapter)` pins the fixed token. Both transport modules use it instead of re-declaring their own. (Required exporting `FactoryProvider`/`ValueProvider` types from `@spinejs/core`.)

### 4. The HTTP transport — `@spinejs/http-gateway`

A concrete transport binding on **Hono**:

- `HttpGateway<Ctx, Code>` composes a `DispatchPipeline`; `bind()` mounts each route with `app.on(method, path, …)`, builds the context via the injected `ContextFactory`, dispatches, and maps the envelope to a `Response` (JSON). Exposes the Hono `app` (for `app.request()` in tests / custom mounting) and a `listen(port)` convenience.
- Ports: `ZodValidator`, `DefaultHttpErrorMapper` (maps to `BAD_REQUEST`/`UNAUTHORIZED`/`INTERNAL_ERROR`), and a **status mapper** (`code → HTTP status`) so the error code stays transport-agnostic while the status is HTTP-specific.
- `HttpGatewayModule.configure({ contextFactory, errorMapper?, validator?, interceptors?, statusMapper?, port?, gateway? })` wires it via DI. A pre-built `gateway` adapter replaces the default factory (used by tests that drive `gateway.app.request()`).
- Routes are declared field-form (ADR 0004) via the framework-level `get`/`post`/… helpers, with `ctx` typed through the `HttpContextRegistry` augmentation; a successful envelope uses the route's `successStatus` (default `200`).

## Alternatives considered

### Keep the abstract `Gateway` base (ADR 0002)

Rejected. The base coupled the pure pipeline with the obligation to subclass, and forced a single `Addr` parameter through inheritance. Composition lets each transport keep its own class shape and address model, and lets the pipeline be unit-tested with a fake `DispatchTarget` and no transport at all.

### One generic transport parameterised by an address strategy

Rejected as over-abstraction: a single configurable gateway class with pluggable address/extraction strategies reproduces inheritance's rigidity with more type gymnastics than two small transports each composing the shared pipeline.

## Consequences

- **Positive**: the pipeline is a plain helper — unit-testable with a fake target, no transport, no subclassing.
- **Positive**: each transport owns its `Addr` model and its bind/register; adding a transport means _composing_ `DispatchPipeline`, not fitting an inherited contract.
- **Positive**: `toProvider`/`ProviderAdapter` removes the duplicated wiring helper across transport modules.
- **Positive**: HTTP and IPC now share the exact same core (one `DispatchPipeline`), guards, ports and field-route loader.
- **Negative**: "gateway" no longer means "a base class" — `@spinejs/gateway-core` is a set of composable **building blocks** (pipeline + DI loader + ports + decorators) used to _build_ a transport gateway, not a gateway itself. Decision: **keep the package name**, but make the docs state this framing explicitly (the Gateway overview opens with it) rather than renaming across the repo now. A rename stays a possible future ticket.
- **Caution**: ADR 0002's "extend `Gateway` / implement `bind()`" guidance is obsolete; a new transport composes a `DispatchPipeline` and implements its own `register`/`bind` instead.
