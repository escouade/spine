# Example — request-scoped unit-of-work with `@spinejs/mikro-orm`

Runnable example of `@spinejs/mikro-orm`: every request gets its own transactional `EntityManager` /
unit-of-work, carried by [`@spinejs/cls`](../../packages/cls). Services persist domain changes at
request end — with **no manager threaded through signatures** and **no `.save()`**. See
[ADR 0016](../../docs/adr/0016-orm-mikro-orm.md) and the
[extension docs](../../apps/docs-site/docs/extensions/mikro-orm.md).

## What it shows

- A `User` entity via `EntitySchema` (no decorators) + a custom `UserRepository`
  (`user.entity.ts`), exposed to the feature module with `MikroOrmModule.register([UserRepository])`.
- `MikroOrmModule.configure({ driver: BetterSqliteDriver, dbName: ":memory:", … })` owns the
  connection: constructed at build, connected on start, closed on stop (`app.module.ts`).
- `UserService.add()` / `rename()` mutate entities and **stop** — no `.save()`, no `EntityManager`
  argument, no transaction bookkeeping (`user.service.ts`).
- The gateway wires the interceptors in the one order that matters: `ClsInterceptor` **then**
  `MikroOrmInterceptor`. The CLS interceptor opens the request scope; the ORM interceptor forks a
  per-request `EntityManager` into it and `flush()`es once at request end — only on a successful
  envelope, so an error persists nothing and a read-only request opens no transaction.

## Run

`electron` is mocked via `@spinejs/electron-ipc-gateway/testing`, so the real `ElectronIpcGateway`
runs without an Electron process, and the sqlite DB is in-memory:

```bash
npx nx test example-mikro-orm-request-uow
```

The spec boots the real `App` and drives IPC dispatches, asserting:

1. **persist without `.save()`** — an `add` survives into a later `byEmail` request (id assigned by the
   request-end flush);
2. **mutation without `.save()`** — a `rename` is dirty-tracked and committed;
3. **error persists nothing** — a handler that throws leaves the unit-of-work unflushed;
4. **concurrent isolation** — two in-flight requests, one committing and one rolling back, do not touch
   each other's unit-of-work (each has its own forked `EntityManager`, isolated by async context).
