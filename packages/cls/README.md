# @spinejs/cls

Per-request context for SpineJS, backed by a single `AsyncLocalStorage` exposed as an injectable singleton `ClsService`. Open a scope per request; deep services read the current request's data via `cls.get()` without threading a context object through every signature. See [ADR 0003](../../docs/adr/0003-cls-request-context.md).

## Quick start

Open a scope at the edge (one per request/dispatch/job), then read it anywhere below.

```typescript
import { Injectable } from "@spinejs/core";
import { ClsService } from "@spinejs/cls";

// At the edge — seed the scope for the async call chain:
@Injectable({ inject: [ClsService] })
export class RequestHandler {
  constructor(private readonly cls: ClsService<{ userId: string }>) {}

  handle(userId: string) {
    return this.cls.run({ userId }, () => this.doWork());
  }
  private doWork() {
    /* deep call chain … */
  }
}

// Anywhere deeper — same singleton, reads the current scope:
@Injectable({ inject: [ClsService] })
export class AuditService {
  constructor(private readonly cls: ClsService<{ userId: string }>) {}
  record(action: string) {
    const userId = this.cls.get("userId"); // no context object threaded in
    /* … */
  }
}
```

Two concurrent `run()`s get isolated stores — the binding is to the async execution context, not to a shared variable.

## With a gateway

`ClsInterceptor` opens a scope around every dispatch. Register it via the transport module's `configure({ interceptors })`, seeding the store from the context:

```typescript
new ClsInterceptor(cls, (ctx) => ({ userId: ctx.session.userId }));
```

## Reference

- **`ClsService<T>`** — `run(seed, fn)` opens a scope and runs `fn` inside it; `get(key)` / `set(key, value)` read/write the current store (`set` throws outside a scope); `active` is `true` inside a `run()`.
- **`ClsModule`** — provides `ClsService` as a singleton.
- **`ClsInterceptor`** — a `GatewayInterceptor` that wraps each dispatch in a scope.

## Full docs

[apps/docs-site/docs/extensions/cls](../../apps/docs-site/docs/extensions/cls.md)
