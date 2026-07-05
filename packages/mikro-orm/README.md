# @spinejs/mikro-orm

MikroORM integration for SpineJS: a **request-scoped `EntityManager` / unit-of-work carried by CLS**. Configure the connection once, register one interceptor, and your services persist domain changes at request end — with **no manager threaded through signatures** and **no `.save()`**. See [ADR 0016](../../docs/adr/0016-orm-mikro-orm.md).

## Install

```bash
yarn add @spinejs/mikro-orm @mikro-orm/core @mikro-orm/better-sqlite
```

`@mikro-orm/core` and a driver are peers — pin both to **v6** (the sqlite drivers do not yet ship v7). `@spinejs/mikro-orm` builds on `@spinejs/cls` for the request scope, so `ClsModule` + `ClsInterceptor` are wired alongside it.

## Quick start

Define the entity with `EntitySchema` (no decorators) and a repository for custom queries. The schema's `repository: () => UserRepository` link lets `register([UserRepository])` resolve the entity:

```typescript
// user.entity.ts
import { EntitySchema, EntityRepository } from "@spinejs/mikro-orm";

export class User {
  id!: number;
  email!: string;
  name!: string;
}
export class UserRepository extends EntityRepository<User> {
  findByEmail(email: string) {
    return this.findOne({ email });
  }
}
export const UserSchema = new EntitySchema<User>({
  class: User,
  repository: () => UserRepository, // required so register([UserRepository]) resolves the entity
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    email: { type: "string" },
    name: { type: "string" },
  },
});
```

Configure the connection once at app level (opens on start with retry, closes on stop), and register the repository in the feature module:

```typescript
// app.module.ts
import { Module } from "@spinejs/core";
import { ClsModule } from "@spinejs/cls";
import { MikroOrmModule } from "@spinejs/mikro-orm";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { UserSchema } from "./user.entity";
import { UserModule } from "./user.module";

@Module({
  imports: [
    ClsModule,
    MikroOrmModule.configure({
      driver: BetterSqliteDriver,
      dbName: "app.sqlite",
      entities: [UserSchema],
      // optional startup retry (defaults: 5 attempts, 200ms, backoff ×2)
      retry: { attempts: 10, delayMs: 500, backoff: 2 },
    }),
    UserModule,
  ],
})
export class AppModule {}

// user.module.ts
@Module({
  imports: [MikroOrmModule.register([UserRepository])],
  providers: [UserService],
})
export class UserModule {}
```

Inject the repository by class token and mutate entities normally — the change is committed at request end, no `.save()`:

```typescript
// user.service.ts
import { Injectable } from "@spinejs/core";
import { UserRepository } from "./user.entity";

@Injectable({ inject: [UserRepository] })
export class UserService {
  constructor(private readonly users: UserRepository) {}
  async rename(id: number, name: string) {
    const user = await this.users.findOneOrFail({ id });
    user.name = name; // dirty-tracked; committed when the request ends. No .save().
  }
}
```

## Wire the interceptor

Register `MikroOrmInterceptor` in your transport's `configure({ interceptors })` **after** `ClsInterceptor` — it forks the request `EntityManager` into the CLS scope, so it must run inside it:

```typescript
interceptors: {
  inject: [ClsService, MikroOrmInterceptor],
  factory: (cls: ClsService, orm: MikroOrmInterceptor) => [
    new ClsInterceptor(cls), // outermost: opens the CLS scope
    orm,                     // inside the scope: forks the EM + brackets the transaction
  ],
}
```

> **Entities:** define them with `EntitySchema` (no decorators) — the portable style under spine's stage-3 / no-`reflect-metadata` build. MikroORM v6 decorator entities are legacy-only (`experimentalDecorators`) and need an explicit `type` per property. See the docs for details.

## Reference

- **`MikroOrmModule.configure(options)`** — registers a connection; `options` are MikroORM `Options` plus an optional `retry: { attempts, delayMs, backoff }`. Constructs at build, connects on `onStart` (with retry), closes on `onStop`. Pass `name` for an additional (named) connection and `multiWrite` to let it be written alongside another (see Multiple connections).
- **`MikroOrmModule.register([...], { connection? })`** — exposes a module's repositories: a custom `EntityRepository` subclass (by class token) or an entity class (default repo via `repositoryOf`). `connection` binds them to a named connection.
- **`repositoryOf(Entity, connection?)`** — a typed `InjectionToken<EntityRepository<Entity>>` for entities with no custom repository; `connection` namespaces the token by connection.
- **`mikroOrmRef(name)` / `entityManagerRef(name)` / `mikroOrmInterceptorRef(name)`** — injection tokens for a named connection's `MikroORM`, request `EntityManager`, and interceptor.
- **`MikroOrmInterceptor`** — forks a per-request `EntityManager` into CLS and `flush()`es it once at request end on a successful envelope (no up-front `begin()`; a request that wrote nothing opens no transaction). Transport-agnostic: add it to the `interceptors` array as-is — the slot is a `ChainInterceptor` whose union admits a base interceptor, so no cast is needed.
- Re-exports `MikroORM`, `EntityManager`, `EntitySchema`, `EntityRepository`, and the `Options` type from `@mikro-orm/core`; plus `mikroOrmProvider` / `entityManagerProvider` / `connectWithRetry` for hand-wiring.

## Multiple connections

One database is the default (class tokens, everything above). For more — a replica, an audit store — give each additional connection a `name`; it is injected via `mikroOrmRef(name)` and brings its own lifecycle. Stack each connection's interceptor (`mikroOrmInterceptorRef(name)`) on the transport. A request writes **at most one** connection unless the connections opt into `multiWrite` (then best-effort sequential — **no cross-DB atomicity**).

## Migrations

Declare a `migrations` block on a connection you already configure — no `mikro-orm.config.ts`, no second source of truth — and the MikroORM Migrator is wired onto it with entity-first defaults (`emit: "ts"`, `snapshot`, `transactional`, `allOrNothing`). A named connection's folder defaults to `./migrations/<name>`, and configuration **fails closed** if two connections would share a path or a tracking table. `@mikro-orm/migrations` (`^6`) is an optional peer, required only when you declare migrations; a connection with no block is byte-for-byte unchanged. Commit migration files **and** the snapshot together.

```ts
MikroOrmModule.configure({
  driver,
  dbName,
  entities: [User],
  migrations: { path: "./migrations" },
});
```

## Limitations

- **No cross-database atomicity** — multiple connections are supported, but a request writes at most one unless you opt into `multiWrite`, and even then flushes are best-effort sequential (no two-phase commit).
- **Pin `@mikro-orm/core` + driver to one major** (v6 today) — a duplicated core copy breaks repository resolution (`instanceof` / token identity).
- **`MikroOrmInterceptor` needs an active CLS scope** — register it after `ClsInterceptor`; outside a scope it fails fast with an explicit diagnostic.

## Full docs

[apps/docs-site/docs/extensions/mikro-orm](../../apps/docs-site/docs/extensions/mikro-orm.md)
