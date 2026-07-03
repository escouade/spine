---
sidebar_position: 3
---

# CLS (request context)

`@spinejs/cls` provides per-request ambient state via Node's `AsyncLocalStorage`, exposed as an
injectable singleton `ClsService`. Use it to make request data (the authenticated user, a correlation
id, the current tenant) available deep in a service graph **without threading a context object**
through every method — and without the cost of a DI request scope (no per-request re-instantiation).

## Installation

`ClsModule` is a standard SpineJS module. Import it wherever you inject `ClsService`:

```typescript
import { Module } from "@spinejs/core";
import { ClsModule } from "@spinejs/cls";

@Module({ imports: [ClsModule] })
export class SomeFeatureModule {}
```

`ClsModule` provides a single shared `ClsService`. Import it in several modules freely — they all see
the same instance, which is required so the code that opens a scope and the code that reads it share
one `AsyncLocalStorage`.

## API

`ClsService<T extends object = ClsStore>` — generic over the store shape. Bare `ClsService` (no
subclass) is untyped: `get`/`set` accept any string key and return `unknown`. Narrow it once per app
by subclassing:

```typescript
import { ClsService } from "@spinejs/cls";

interface AppStore {
  user: string;
  reqId: string;
}

// Empty body: purely a typed DI token + injection type, never instantiated directly.
export class DispatchContext extends ClsService<AppStore> {}
```

- `run<R>(seed, fn): R` — opens a scope seeded with a copy of `seed`, runs `fn` inside it.
- `get active(): boolean` — whether a scope is currently active.
- `get<K extends keyof T>(key): T[K] | undefined` — read the active scope, key-checked against `T`
  (`undefined` outside any scope).
- `set<K extends keyof T>(key, value): void` — write the active scope, key-checked (throws outside a
  scope).
- `has(key): boolean` — whether the key exists in the active scope.

## Opening a scope per request

`ClsService.run()` is the per-request boundary. With the gateway, open it from an interceptor — the
gateway core is not touched. `@spinejs/cls` exports a generic `ClsInterceptor`, so apps don't hand-write
one: by default it seeds the store by spreading the whole dispatch context; pass a `seed` function for
anything derived (here a generated `reqId`):

```typescript
import { randomUUID } from "node:crypto";
import { ClsInterceptor, ClsService } from "@spinejs/cls";

// in your transport's configure({ interceptors }):
{
  inject: [ClsService],
  factory: (cls: ClsService) => [
    new ClsInterceptor<AppContext>(cls, (ctx) => ({ user: ctx.user, reqId: randomUUID() })),
  ],
}
```

## Reading the context

Inject your typed `DispatchContext` subclass into any singleton service — no `ctx` parameter, no
factory: it's aliased to the same `ClsService` singleton via an `existing` provider (same instance,
just re-typed against `AppStore`, no extra object):

```typescript
@Module({
  providers: [AuditService, { provide: DispatchContext, existing: ClsService }],
})
export class FeatureModule {}
```

```typescript
import { Injectable } from "@spinejs/core";
import { DispatchContext } from "./dispatch-context";

@Injectable({ inject: [DispatchContext] })
export class AuditService {
  constructor(private readonly dispatchContext: DispatchContext) {}
  log(action: string) {
    const user = this.dispatchContext.get("user"); // typed: string | undefined
    // ...
  }
}
```

## Concurrency

`AsyncLocalStorage` binds the store to the async execution context, not to an instance. Two
concurrent requests get isolated stores, so the same singleton returns each request's own value.

## Guidance

- Centralise the `AsyncLocalStorage` in `ClsService` — never instantiate one elsewhere.
- For shallow needs (a handler reading `ctx.user` directly), just use the context; CLS earns its keep
  when a deep service graph would otherwise thread `ctx` everywhere.
- Calling `get` outside a scope returns `undefined`; `set` throws. Make sure every entry point that
  needs the context opens one with `run()`.

A full runnable example lives in `examples/cls-request-context`.
