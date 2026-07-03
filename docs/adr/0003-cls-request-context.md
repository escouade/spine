# ADR 0003 — Per-request ambient context via AsyncLocalStorage (`@spinejs/cls`)

- **Status**: Accepted
- **Date**: 2026-06-30
- **Scope**: new package `packages/cls`; consumed by gateway transports via their existing
  interceptor hook. No change to `packages/gateway`. `packages/core`'s DI container gains one
  generic addition (an `existing`/alias provider, §5) — not cls-specific, but added for this.
- **Relation**: resolves the per-request / per-event scope deferred by
  [ADR 0001](0001-di-provider-scope.md) (which kept the DI core at `singleton | transient`). Builds
  on the transport pipeline of [ADR 0002](0002-gateway-transport-agnostic.md).

## Context

A server process handles many requests (IPC events) over shared singletons. Some data is **specific
to one request** and must never leak to a concurrent one: the authenticated user/session, a
correlation `reqId`, a per-request transaction, the current tenant. Putting it on a singleton lets
request B overwrite request A's data mid-flight — a cross-request data leak.

The data already travels on the dispatch `ctx`, so a handler can read it directly. The pain appears
only when a **deep service graph** needs that data: every intermediate method signature has to thread
`ctx` (`orderService.create(ctx, …)` → `auditService.log(ctx, …)`), polluting the whole call chain.

Two textbook answers exist:

1. **DI request scope** (NestJS `Scope.REQUEST`): a fresh **instance** per request, auto-injected.
   But constructor injection means the **resolver** must understand a per-request resolution context,
   and the scope **bubbles** — any consumer of a request-scoped provider itself becomes
   request-scoped and is **re-instantiated per request**. That puts a "request" notion **inside the
   DI core** and re-runs resolution for a subtree on every request. ADR 0001 deliberately refused to
   couple the core to this.
2. **AsyncLocalStorage (CLS)**: keep singletons singleton; bind the per-request data to the **async
   execution context** instead of to an instance. A singleton reads the _current_ request's store at
   call time. No re-instantiation, no resolver change.

## Decision

Adopt CLS, packaged as a small, transport-agnostic library, and open the per-request scope from the
gateway's **existing** interceptor hook.

### 1. New package `@spinejs/cls`

A single owner of one `AsyncLocalStorage`, exposed as an injectable singleton `ClsService`, generic
over the store shape (untyped by default):

```ts
export type ClsStore = Record<string, unknown>;

export class ClsService<T extends object = ClsStore> {
  private readonly als = new AsyncLocalStorage<ClsStore>();
  run<R>(seed: T, fn: () => R): R; // opens a scope, runs fn inside it
  get active(): boolean; // inside an active scope?
  get<K extends keyof T & string>(key: K): T[K] | undefined; // read the current scope
  set<K extends keyof T & string>(key: K, value: T[K]): void; // write it (throws outside one)
  has(key: keyof T & string): boolean;
}
```

`ClsModule` provides the bare `ClsService` as a singleton and exports it. It depends only on
`@spinejs/core` (for `@Module`) and `node:async_hooks`. It knows nothing about the gateway, HTTP, or
"requests".

### 2. The scope is opened by a generic gateway interceptor

`ClsService.run(seed, next)` **is** the per-request boundary — one `run` per dispatch. `@spinejs/cls`
exports a generic `ClsInterceptor<Ctx>` (apps don't hand-write one); it lives behind a
`GatewayInterceptor` (the pipeline's existing extension point, ADR 0002), so **the gateway core is
not modified**:

```ts
export class ClsInterceptor<Ctx extends GatewayContext>
  implements GatewayInterceptor<Ctx>
{
  constructor(
    private readonly cls: ClsService,
    private readonly seed: (ctx: Ctx) => ClsStore = (ctx) =>
      ({ ...ctx } as ClsStore)
  ) {}
  intercept(_route, ctx, _input, next) {
    return this.cls.run(this.seed(ctx), next);
  }
}
```

The default `seed` spreads the whole dispatch context — enough for most apps (`interface AppContext`
declared once). A custom `seed` is only needed for derived data (e.g. a generated `reqId`); it's
app-specific, so it's passed in, not hand-coded as a whole interceptor class:

```ts
new ClsInterceptor<AppContext>(cls, (ctx) => ({
  user: ctx.user,
  reqId: randomUUID(),
}));
```

Registered through the transport's `configure({ interceptors })`, same as before.

### 3. Consumers inject `ClsService` — or a typed `DispatchContext` (DI stays clean)

A deep service reads the current request without any `ctx` threaded in. Untyped:

```ts
@Injectable({ inject: [ClsService] })
class AuditService {
  constructor(private readonly cls: ClsService) {}
  log(action: string) {
    /* this.cls.get("user"), this.cls.get("reqId") — both `unknown` */
  }
}
```

`AuditService` stays a **singleton**, injected normally. For type-safety, an app declares its store
shape once and narrows `ClsService` via an **empty subclass**, aliased to the same singleton — see §5:

```ts
interface AppStore {
  user: string;
  reqId: string;
}
class DispatchContext extends ClsService<AppStore> {} // empty body: a typed DI token, nothing more

@Injectable({ inject: [DispatchContext] })
class AuditService {
  constructor(private readonly ctx: DispatchContext) {}
  log(action: string) {
    /* this.ctx.get("user") — string | undefined, key-checked */
  }
}
```

### 4. Concurrency guarantee

`AsyncLocalStorage` binds the store to the **async context**, not to an instance. Two concurrent
`run()`s see isolated stores, so the same singleton returns the right per-request value in each
branch:

```
Request A ─ cls.run({ user: Alice }, …) ─▶ AuditService.log() ─ cls.get("user") → Alice
Request B ─ cls.run({ user: Bob   }, …) ─▶ AuditService.log() ─ cls.get("user") → Bob
```

### 5. Typed access costs no factory: an `existing` (alias) provider in the DI container

Wiring `DispatchContext` (§3) needs the container to resolve it to the **same instance** as
`ClsService` — not a new object wrapping it (a wrapper would need its own factory, the thing this is
meant to avoid). `packages/core`'s `Provider<T>` union gains a fifth shape, generic, not cls-specific:

```ts
export interface ExistingProvider<T = unknown> {
  provide: Token<T>;
  existing: Token<T>;
}
```

Resolving `provide` resolves `existing` instead — pure alias, same cache slot, same identity:

```ts
{ provide: DispatchContext, existing: ClsService }
```

`container.get(DispatchContext) === container.get(ClsService)` — literally the same object, just
exposed under a second, more specific token. This is a known DI idiom (Angular/NestJS `useExisting`);
it earns its keep here specifically because `DispatchContext` is an **empty subclass** — a class with
no members of its own only exists as a typed marker, so aliasing it to the actual singleton (instead
of constructing a real instance through a factory) is exactly the right fit, with zero runtime cost
beyond the alias lookup.

## Alternatives considered

### DI request scope with bubbling (NestJS `Scope.REQUEST`)

Rejected: requires the DI core to learn a per-request resolution context (`ContextId`) plus scope
contagion, and re-instantiates a subtree per request. Couples the core to "request" (the very thing
ADR 0001 avoided) for a payoff an IPC/desktop app — single user, no multi-tenant concurrency — rarely
needs.

### Thread `ctx` everywhere

Kept for shallow cases (a handler reading `ctx.user` directly is fine). Rejected as the _general_
mechanism: it pollutes every intermediate signature in a deep graph, which is exactly the ergonomics
CLS restores.

### Bake CLS into the gateway

Rejected: CLS is a generic capability (cron jobs, queues, other transports want it too). Folding it
into `@spinejs/gateway-core` would tie a transport-agnostic primitive to the gateway and pull
`node:async_hooks` into the pipeline. A standalone package consumed via the interceptor hook keeps
both clean.

### Expose `AsyncLocalStorage` / `getStore()` directly across the app

Rejected as an anti-pattern when scattered: raw `getStore()` in many files is an invisible, untestable
dependency. `ClsService` is the **single** owner; consumers go through it (and optionally a typed
wrapper). A generic exposed store (like `nestjs-cls`) is acceptable precisely because there is one
owner.

### A factory-built wrapper class for typed access

Earlier shape of this ADR: `class DispatchContext { constructor(private cls: ClsService) {} get(...) {...} }`,
registered with `{ provide: DispatchContext, inject: [ClsService], factory: (cls) => new DispatchContext(cls) }`.
Works, but every app pays a 4-line factory for what is, at runtime, the exact same `ClsService`
instance wearing a narrower type. Rejected once the `existing` alias (§5) made the wrapper
unnecessary — the empty-subclass-plus-alias form has the identical type-safety with no constructed
object and no factory boilerplate.

## Consequences

- **Positive**: `packages/gateway` is untouched — the scope rides the existing interceptor hook. The
  DI model stays `singleton | transient`; `packages/core` only gained one generic, cls-agnostic
  provider shape (`existing`, §5), not a "request" concept.
- **Positive**: no per-request re-instantiation; singletons stay shared; concurrency-safe by
  construction.
- **Positive**: `@spinejs/cls` is reusable beyond the gateway (jobs, schedulers, any async entry
  point that calls `run()`).
- **Positive**: typed access (`DispatchContext`) costs zero extra runtime objects and zero factories —
  an empty subclass aliased via `existing`.
- **Negative**: a small `node:async_hooks` overhead per scope, and an **ambient** dependency — the
  reliance on request state is not visible in a method's parameters (mitigated by centralising it in
  `ClsService` / a typed wrapper).
- **Caution**: every entry point that needs the context must open a scope (`run()`); calling `get`
  outside one returns `undefined` and `set` throws. Centralise the `AsyncLocalStorage` in
  `ClsService` — never instantiate it elsewhere.
- **Caution**: an interceptor seeding the scope must wrap the whole pipeline; guards and handlers run
  inside `next()`, so they already see the store.
