# ADR 0004 — Field-form routes ("solution A"): schema-inferred handlers without reflect-metadata

- **Status**: Accepted
- **Date**: 2026-07-01
- **Scope**: `packages/gateway`, `packages/http-gateway`, `packages/electron-ipc-gateway`, `packages/core`
- **Relation**: refines the transport-agnostic gateway of [ADR 0002](./0002-gateway-transport-agnostic.md). Supersedes its `@Handler`/method-route surface.

## Context

ADR 0002 declared routes as **controller methods** decorated with `@Handler({ address, input? })`
(and the HTTP `@Get`/`@Post`/… sugar). Two problems surfaced:

1. **No input typing.** `@Handler` could not infer the handler's `input` type from its zod schema. The
   handler signature was `(ctx, input: unknown)`; the developer had to hand-annotate `input`, which
   duplicates the schema and silently drifts from it.
2. **Stage-3 decorators.** The repo builds with esbuild (Electron main + Vite) under **default
   stage-3 decorators, no `reflect-metadata`, no `emitDecoratorMetadata`**. A NestJS-style
   `@Body() dto: CreateUserDto` cannot work — it relies on parameter decorators + emitted design-time
   types, both unavailable here. `@Handler` itself only kept working as a _legacy_ decorator and was
   never exercised under the default pipeline (see the project memory note on the stage-3 gap).

The goal: a route declaration where the handler's `input` is **inferred from the zod schema** (one
source of truth, compile-time link), that works under stage-3 esbuild with no reflect-metadata.

## Decision

### 1. Routes are controller instance **fields**, built by framework-level helpers ("solution A")

A transport exports module-level route helpers (`get`/`post`/… for HTTP, `handle` for IPC). Each route
is a class **field** initialized by a helper, not a decorated method:

```ts
import { get, post } from "@spinejs/http-gateway";

@Controller({ inject: [UsersStore] })
export class UsersController {
  constructor(private readonly users: UsersStore) {}

  list = get("/users", { query: listQuerySchema }, ({ query }) =>
    this.users.list(query.role)
  );
  create = post(
    "/users",
    { body: createSchema, successStatus: 201 },
    ({ body }) => this.users.create(body)
  );
}
```

The helper is a **function call**, so the schemas object is a value the generic captures: the callback
receives `input` **inferred** from the schemas (split by source for HTTP: `{ params, query, body }`),
and `ctx` typed without annotation. The user writes `(input, ctx)`; an internal flip adapts it to the
pipeline's `invoke(ctx, input)`. Each helper returns a `RouteMarker` (a branded plain object);
`getRoutes` scans the controller instance's own fields for markers at registration time. No
decorator, no reflect-metadata.

The marker-construction boilerplate (brand + arg flip) is shared in `@spinejs/gateway-core`
(`makeRouteMarker`); each transport supplies only its address model, its composed input schema, and
opaque `meta`. HTTP `{ method, path }`, IPC a string channel.

### 1a. The default `ctx` comes from a context registry, not a per-app factory

The initial cut bound `ctx` via a per-app factory: `const { get, post } = httpRoutes<AppContext>()`,
exported from an `app-context.ts` and imported by every controller. That binding only ever served to
type `ctx` (input inference comes from the options literal `S`, independent of the wrapper), yet it
cost an ambiguous per-app helper file and a feature→app-root import.

Replaced by an **augmentable context registry** (the Express `declare module` pattern). Each transport
declares an empty `interface HttpContextRegistry {}` and derives
`type DefaultCtx = HttpContextRegistry extends { context: infer C } ? C : HttpBaseContext`. The app
augments it **once**:

```ts
declare module "@spinejs/http-gateway" {
  interface HttpContextRegistry {
    context: AppContext;
  }
}
```

Controllers then import `get`/`post`/`handle` straight from the transport package; `ctx` defaults to
`DefaultCtx` and a single route overrides it by annotating its callback's `ctx`
(`(_input, ctx: Other) => …`). Without the augmentation, `DefaultCtx` falls back to the transport base
context, so app fields like `ctx.user` do not exist — the augmentation is mandatory once per app. The
`httpRoutes()`/`ipcRoutes()` factories remain exported but `@deprecated` for a soft transition.

### 2. `@Handler` and the method-route path are removed

`@Handler`, `HandlerOptions`, the HTTP `@Get`/`@Post`/`@HttpHandler` decorators, and the method-route
branch of `getRoutes` are deleted. Field-form is the **single** way to declare a route. `@Controller`
stays (marks the class + folds in `@Injectable` with typed `inject`).

### 3. Guards: class-level decorator + per-route option

- **Whole controller** (the common auth case): `@UseGuards(AuthGuard)` on the class — unchanged,
  statically discoverable on the constructor.
- **One route**: a `guards: [...]` entry in the helper options. Because a route is now a _field_, not
  a method, there is no method decorator target; per-route granularity lives in the options object.
  Class-level and per-route guards are merged (class first), then resolved by DI.

`@UseGuards` is therefore **class-only** now (its method branch is removed).

### 4. Per-route guards force lazy DI resolution via the module's own container

Per-route guard **classes** live inside controller fields, so they are unknown until the controller is
instantiated — the feature module cannot collect them at definition time to add to `providers`/
`inject` (as it did for class-level guards in ADR 0002). Instead, the synthesized feature module
resolves **all** guards lazily at `onInit`: it scans the controller instances for referenced guard
classes (class-level + marker), registers any unknown class on demand, and resolves it from its own
container — so an `@Injectable` guard's deps resolve from the same container (its imports' exports +
providers).

To reach its container, the feature module reads a **framework-internal back-channel**: `@spinejs/core`'s
module loader stamps each module instance with its own `Container` on a hidden, non-enumerable slot
(keyed by `Symbol.for("spinejs:module-own-container")`) just before `onInit`. This is **not** a public
token and **not** part of the DI graph; the key is a `Symbol.for` so `@spinejs/gateway-core` re-derives it
without `@spinejs/core` exporting anything, and user code never sees it.

### 5. Per-route success status (HTTP)

A route may set `successStatus` in its options (carried in `meta`); the HTTP transport uses it for a
successful envelope, defaulting to `200` (e.g. `201` for a creation). Error statuses stay driven by
the `ErrorMapper` → status-mapper chain.

## Alternatives considered

### Keep `@Handler` methods + hand-annotated input (NestJS-shaped, "loose typing")

Rejected. Routes stay methods (so `@UseGuards` on a method comes back for free), but the handler's
`input` type is _declared by hand_, decoupled from the zod schema — two sources that drift, no
compile-time guarantee the validated payload matches the annotation. The whole reason for solution A
is to keep the schema as the single source of truth.

### NestJS parameter decorators (`@Body`, `@Param`)

Rejected. Requires `reflect-metadata` + `emitDecoratorMetadata`, unavailable under the esbuild/stage-3
build (same conclusion as ADR 0002 for the NestJS runtime).

### Per-route guards via a field decorator (`@UseGuards` on a field)

Rejected. Decorating a class field is exactly the fragile stage-3 path this project avoids, and it is
untested under the default pipeline. Options-bag guards are plain values — no decorator involved.

### A public `Container`/`ModuleRef` token to resolve guards

Rejected for now. Exposing the resolver as an injectable (NestJS `ModuleRef`, Angular `Injector`) is a
valid Service-Locator escape hatch, but it advertises a footgun to user code. The internal back-channel
gives the feature module exactly the capability it needs with **zero public surface**; the token can be
promoted later if app code ever needs dynamic resolution.

## Consequences

- **Positive**: a route's `input` is inferred from its schema — one source of truth, compile-time
  link, no hand annotation, no drift.
- **Positive**: works under stage-3 esbuild with no `reflect-metadata`; no decorator on the hot path.
- **Positive**: one route-declaration model across transports; `makeRouteMarker` removes the
  per-transport boilerplate.
- **Positive**: per-route guards and success status without reopening the decorator surface.
- **Negative**: routes-as-fields is unusual (developers expect methods); mitigated by the helper's
  docstrings and the docs.
- **Negative**: guards resolve lazily at `onInit` rather than being constructor-injected; a missing
  guard dep now surfaces at init instead of at module construction.
- **Caution**: the `Symbol.for("spinejs:module-own-container")` slot is a contract shared between
  `@spinejs/core` and `@spinejs/gateway-core` — keep the key in sync if either side changes.
- **Caution**: a guard's deps must be resolvable from the feature module's container (its imports'
  exports + providers), same constraint as any provider it loads.

```

```
