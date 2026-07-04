---
sidebar_position: 4
---

# MikroORM (persistence)

`@spinejs/mikro-orm` gives every request its own transactional `EntityManager` / unit-of-work,
carried by spine's [CLS](./cls). You configure the connection **once**, register **one** interceptor,
and your services persist domain changes at request end — with **no manager threaded through
signatures** and **no `.save()`**. A service loads an entity, mutates it, and the change is committed
when the request succeeds or rolled back when it throws.

## Installation

```bash
yarn add @spinejs/mikro-orm @mikro-orm/core @mikro-orm/better-sqlite
```

`@mikro-orm/core` and a driver (here `@mikro-orm/better-sqlite`) are peers — pick the driver for your
database. The package builds on [`@spinejs/cls`](./cls) for the request scope, so `ClsModule` and its
`ClsInterceptor` are wired alongside it (shown below). Pin MikroORM to **v6** (core **and** driver):
the sqlite drivers do not yet ship v7.

## A minimal app

We build a `User` resource end-to-end: model the data, configure the connection, register the
repository, use it in a service. New to SpineJS? Follow [Getting Started](../getting-started) for the
`main.ts` → gateway → controller journey first; this page picks up at persistence.

```
src/
  user.entity.ts
  modules/
    app.module.ts
    user/
      user.module.ts
      user.service.ts
```

### 1. The entity and its repository — `user.entity.ts`

Define the entity with **`EntitySchema`** (no decorators) and, optionally, a repository subclass as
the home for custom queries. The schema links the two with `repository: () => UserRepository` — that
link is what lets `register([UserRepository])` (step 3) find the entity.

```typescript
// src/user.entity.ts
import { EntitySchema, EntityRepository } from "@spinejs/mikro-orm";

export class User {
  id!: number;
  email!: string;
  name!: string;
}

// The home for custom queries — injected later by its class token.
export class UserRepository extends EntityRepository<User> {
  findByEmail(email: string) {
    return this.findOne({ email });
  }
}

export const UserSchema = new EntitySchema<User>({
  class: User,
  repository: () => UserRepository, // REQUIRED so register([UserRepository]) resolves the entity
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    email: { type: "string" },
    name: { type: "string" },
  },
});
```

:::warning ⚠️ Define entities with `EntitySchema`, not decorators
Under spine's build (esbuild / stage-3 decorators, **no** `emitDecoratorMetadata`), MikroORM **v6**
entity decorators (`@Entity`, `@Property`, …) are **legacy-only** — they require
`experimentalDecorators` and do **not** work with the stage-3 decorators spine targets.
**`EntitySchema` (no decorators) is the portable, recommended style** — it needs no `reflect-metadata`
and works everywhere.

If you must use decorator entities (legacy mode only), you also lose `emitDecoratorMetadata`, so every
property needs an explicit `type`: `@Property({ type: "string" })`, never a bare `@Property()`.
MikroORM **v7** adds stage-3 decorators via `@mikro-orm/decorators/es` (still without
`reflect-metadata`) — usable once the package moves to v7.
:::

### 2. Configure the connection once — `modules/app.module.ts`

`MikroOrmModule.configure(options)` registers a single connection at app level. The `MikroORM`
instance is constructed at module build, **connected on start** (with retry) and **closed on stop** —
the module owns the lifecycle, you never call `connect()`/`close()` yourself. Import `ClsModule`
alongside it: the request scope rides CLS.

```typescript
// src/modules/app.module.ts
import { Module } from "@spinejs/core";
import { ClsModule } from "@spinejs/cls";
import { MikroOrmModule } from "@spinejs/mikro-orm";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { UserSchema } from "../user.entity";
import { UserModule } from "./user/user.module";

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
```

### 3. Expose the repository — `modules/user/user.module.ts`

`MikroOrmModule.register([...])` makes a module's repositories injectable **by class token**. It
merges into the same app-level connection — `configure()` opens it, every `register()` exposes a slice
of it.

```typescript
// src/modules/user/user.module.ts
import { Module } from "@spinejs/core";
import { MikroOrmModule } from "@spinejs/mikro-orm";
import { UserRepository } from "../../user.entity";
import { UserService } from "./user.service";

@Module({
  imports: [MikroOrmModule.register([UserRepository])],
  providers: [UserService],
})
export class UserModule {}
```

### 4. Use it — `modules/user/user.service.ts`

Inject the repository by its class token (typed `inject:`, [ADR 0008 style](../core/dependency-injection)).
Load an entity, mutate it, and **stop** — the change is dirty-tracked and committed when the request
ends. No `.save()`, no `EntityManager` argument, no transaction bookkeeping.

```typescript
// src/modules/user/user.service.ts
import { Injectable } from "@spinejs/core";
import { UserRepository } from "../../user.entity";

@Injectable({ inject: [UserRepository] })
export class UserService {
  constructor(private readonly users: UserRepository) {}

  async rename(id: number, name: string) {
    const user = await this.users.findOneOrFail({ id });
    user.name = name; // dirty-tracked; committed when the request ends. No .save().
  }
}
```

One piece remains: the interceptor that opens the per-request transaction. It is what makes step 4
work, and it is wired on the transport — next.

## Wiring the transactional interceptor

`MikroOrmInterceptor` is what turns step 4 into a committed transaction. Register it in your
transport's `configure({ interceptors })`, **after** `ClsInterceptor` — it forks the request
`EntityManager` into the CLS scope, so it must run **inside** the scope `ClsInterceptor` opens. (See
[Interceptors](../gateway/interceptors) for the `interceptors` adapter — a `value` or a DI `factory`.)

```typescript
// wherever you configure the transport (HTTP, IPC, …)
import { ClsInterceptor, ClsModule, ClsService } from "@spinejs/cls";
import { MikroOrmInterceptor } from "@spinejs/mikro-orm";

HttpGatewayModule.configure({
  imports: [ClsModule], // ClsService for the ClsInterceptor
  contextFactory: {
    /* … */
  },
  interceptors: {
    inject: [ClsService, MikroOrmInterceptor],
    factory: (cls: ClsService, orm: MikroOrmInterceptor) => [
      new ClsInterceptor(cls), // 1. outermost: opens the CLS scope
      orm, // 2. inside the scope: forks the EM + brackets the transaction
    ],
  },
});
```

`MikroOrmInterceptor` is exported by `MikroOrmModule.configure()` (registered app-level in step 2), so
the interceptor factory resolves it by token. Order matters: `ClsInterceptor` first (it opens the
scope), `MikroOrmInterceptor` after (it writes the fork into that scope).

## How the transaction works

The interceptor is the whole differentiator, and it is small:

```typescript
const em = this.orm.em.fork(); // fresh identity map + unit-of-work for THIS request
this.cls.set(EM, em); // every injected repository/EntityManager now resolves to it
const res = await next(); // your handlers + services run here
// The pipeline never throws: business errors come back as { ok: false }. Flush only a successful
// unit-of-work — MikroORM wraps the pending changes in ONE transaction (atomic, no explicit .save()).
// A request that wrote nothing flushes nothing (no transaction); an error envelope persists nothing.
if (res.ok) {
  await em.flush();
}
return res;
```

Why there is no `.save()`: MikroORM has a **unit-of-work** and an **identity map**. When you load an
entity through the request's `EntityManager`, the ORM tracks it; mutating a field marks it dirty; the
request-end `flush()` writes every tracked change in one transaction — and a request that changed
nothing opens no transaction at all. `fork()` gives each request its own identity map, so two
concurrent requests never see each other's pending writes — the fork is bound to
the async context (CLS), not to the injected singleton.

`orm.em` — the getter you inject as `EntityManager` — is always the **root** manager; each operation
it exposes (`find`, `persist`, …) delegates to the current request's fork via `getContext()`. So an
injected `EntityManager` or repository resolves the fork transparently. Compare identities on
`orm.em.getContext()`, never on `orm.em`.

:::note A scope must be active
Outside a request (no CLS scope with a fork set), there is no fork to resolve. Every entry point that
touches the database must run inside the interceptor's scope. For work outside a request (a CLI task,
a seed script), open a scope yourself and `orm.em.fork()` manually.
:::

## Entities with no custom repository

A repository subclass is optional. For an entity that needs no custom queries, register the **entity
class** and inject its default repository through `repositoryOf(Entity)` — a typed
`InjectionToken<EntityRepository<Entity>>`:

```typescript
// user.module.ts — register the entity class instead of a repository
@Module({ imports: [MikroOrmModule.register([User])] })
export class UserModule {}
```

```typescript
// user.service.ts — inject the default repository by token
import { Injectable } from "@spinejs/core";
import { EntityRepository, repositoryOf } from "@spinejs/mikro-orm";
import { User } from "../../user.entity";

@Injectable({ inject: [repositoryOf(User)] })
export class UserService {
  constructor(private readonly users: EntityRepository<User>) {}
  find(id: number) {
    return this.users.findOne({ id });
  }
}
```

`repositoryOf(User) === repositoryOf(User)` — the token is stable per entity, so the same call
provides and injects it. A wrong token type in an `inject:` array fails to **compile**, not at
runtime.

## Startup retry

A transient database (a container still booting, a brief network blip) should not abort the whole app
on the first failed connect. `configure({ retry })` retries the **initial** connect with backoff; only
after the budget is exhausted does startup throw — which aborts boot cleanly rather than starting
half-connected.

```typescript
MikroOrmModule.configure({
  driver: BetterSqliteDriver,
  dbName: "app.sqlite",
  entities: [UserSchema],
  retry: { attempts: 10, delayMs: 500, backoff: 2 }, // 500 → 1000 → 2000ms …
});
```

Omit `retry` to use the default policy: **5 attempts, 200ms, backoff ×2** (200 → 400 → 800 → 1600ms).
Losing the connection _while running_ is a different problem, handled by the driver's connection pool
(surface its options through the same MikroORM `Options`); the package retries only the initial
connect.

## Logging

The module bridges MikroORM's own output (queries under `debug`, connection events) to the spine
[logger](../core/logging) — **one sink**, not a second stream — and logs its own connection lifecycle
(connecting, connected, retry attempt _N_, final failure, closing). A `logger` you pass in
`configure()` options wins; if no spine logger is available the bridge degrades to a no-op and never
throws.

## Wiring it by hand (the factory) {#by-hand}

`configure()` is not magic — it is a small, inspectable DI composition: a value provider for the
options, a factory provider for `MikroORM` (`mikroOrmProvider`), the `EntityManager` provider
(`entityManagerProvider`), the interceptor, and the repository tokens. All of it is ordinary spine DI,
so you can write the same wiring by hand when you want full control over `MikroORM.initSync(...)`. The
package exports the building blocks — `mikroOrmProvider`, `entityManagerProvider`, and
`connectWithRetry` — for exactly this.

Here is the equivalent of `configure()`, spelled out. It reuses the exported `entityManagerProvider`
and `connectWithRetry`, and writes out the `MikroORM` factory and the interceptor so you can see the
two load-bearing lines: the CLS `context` hook and the `fork()` per request.

```typescript
// src/modules/db.module.ts
import {
  Module,
  loggerToken,
  type DynamicModule,
  type FactoryProvider,
  type Logger,
  type OnStart,
  type OnStop,
} from "@spinejs/core";
import { ClsModule, ClsService } from "@spinejs/cls";
import type {
  DispatchTarget,
  Envelope,
  GatewayContext,
  GatewayInterceptor,
} from "@spinejs/gateway-core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import {
  MikroORM,
  EntityManager,
  connectWithRetry,
  entityManagerProvider,
} from "@spinejs/mikro-orm";
import { UserSchema } from "../user.entity";

// The single CLS key the factory reads and the interceptor writes — the handshake between them.
const EM = "app:orm-em";

// 1. Construct (not connect) MikroORM at build; point its `context` hook at spine's CLS.
const ormProvider: FactoryProvider<MikroORM> = {
  provide: MikroORM,
  inject: [ClsService, loggerToken],
  factory: (cls: ClsService, log?: Logger): MikroORM =>
    MikroORM.initSync({
      driver: BetterSqliteDriver,
      dbName: "app.sqlite",
      entities: [UserSchema],
      context: () => cls.get(EM) as EntityManager | undefined, // ← one ALS, spine's
      logger: (msg) => log?.debug(msg, "Db"), // bridge MikroORM output to the spine logger
    }),
};

// 2. Fork + flush the unit-of-work per dispatch (what MikroOrmInterceptor does).
export class TransactionInterceptor implements GatewayInterceptor {
  constructor(
    private readonly orm: MikroORM,
    private readonly cls: ClsService
  ) {}
  async intercept(
    _target: DispatchTarget<GatewayContext>,
    _ctx: GatewayContext,
    _rawInput: unknown,
    next: () => Promise<Envelope<unknown>>
  ): Promise<Envelope<unknown>> {
    const em = this.orm.em.fork();
    this.cls.set(EM, em);
    const res = await next();
    // The pipeline never throws: business errors are { ok: false }. Flush only a success — atomic,
    // no .save(); a request that wrote nothing opens no transaction, an error persists nothing.
    if (res.ok) {
      await em.flush();
    }
    return res;
  }
}

// 3. Own the connection lifecycle; retry the initial connect via the exported helper.
@Module({ inject: [MikroORM, loggerToken] })
export class DbModule implements OnStart, OnStop {
  constructor(private readonly orm: MikroORM, private readonly log: Logger) {}
  onStart(): Promise<void> {
    return connectWithRetry(
      this.orm,
      { attempts: 5, delayMs: 200, backoff: 2 },
      this.log
    );
  }
  async onStop(): Promise<void> {
    await this.orm.close(true);
  }
  static provide(): DynamicModule {
    return {
      module: DbModule,
      imports: [ClsModule],
      // entityManagerProvider is reused verbatim — it exposes `orm.em` as the EntityManager token.
      providers: [ormProvider, entityManagerProvider],
      exports: [MikroORM, EntityManager],
    };
  }
}
```

Import `DbModule.provide()` in your `AppModule`, and wire `new TransactionInterceptor(orm, cls)` in the
transport `interceptors` factory exactly as the batteries-included `MikroOrmInterceptor` is wired
above. The module is the convenient path; this factory is the escape hatch and the transparency —
nothing about `configure()` is hidden.

## Limitations

- **One connection per app.** `MikroOrmModule.configure()` owns a single MikroORM connection for the
  whole app — importing it (or calling `configure()`) more than once resolves the **same** instance. A
  second `configure({...})` with _different_ options is silently ignored (the first options win); this
  package does not model multiple simultaneous databases. Use one `configure()` at the app root.
- **Pin `@mikro-orm/core` and its driver to the same major.** Repository resolution relies on
  `instanceof EntityRepository` and a per-entity token map, both identity-sensitive. A **duplicated**
  `@mikro-orm/core` in the tree (a driver on a different major, a version skew) yields a second
  `EntityRepository` class and breaks `register([...])`. Keep `@mikro-orm/core` and the
  `@mikro-orm/*` driver on one major (v6 today) — a single copy in the dependency tree.
- **The interceptor requires an active CLS scope.** Register `MikroOrmInterceptor` **after**
  `ClsInterceptor` (see _Wiring the transactional interceptor_ above). Run outside a scope, it fails
  fast with an explicit diagnostic naming the fix, rather than an opaque error.

## Reference

### `MikroOrmModule.configure(options)`

Registers the single app-level connection: constructs `MikroORM` at module build, connects on
`onStart` (with retry), closes on `onStop`. `options` is MikroORM's `Options` (all of it — `driver`,
`dbName`, `entities`, `pool`, `logger`, `debug`, …) plus one spine-added field:

| Option   | Type                   | Default         | Meaning                                      |
| -------- | ---------------------- | --------------- | -------------------------------------------- |
| `retry`  | `Partial<RetryPolicy>` | `DEFAULT_RETRY` | Startup connect-retry policy (below).        |
| _(rest)_ | MikroORM `Options`     | —               | Driver, `dbName`, `entities`, pool, logging. |

`RetryPolicy` and its defaults (`DEFAULT_RETRY`):

| Field      | Type     | Default | Meaning                                                              |
| ---------- | -------- | ------- | -------------------------------------------------------------------- |
| `attempts` | `number` | `5`     | Total connect attempts, including the first (`>= 1`).                |
| `delayMs`  | `number` | `200`   | Delay before the first retry, in ms.                                 |
| `backoff`  | `number` | `2`     | Multiplier applied to the delay after each failure (`1` = constant). |

Any field omitted from `retry` falls back to its `DEFAULT_RETRY` value.

### `MikroOrmModule.register([...])`

Exposes a module's repositories, each injectable by token. Each entry is either:

- a **custom repository class** (an `EntityRepository<Entity>` subclass) — injected by its class token;
  the entity is read back from the schema's `repository: () => …` link, so the schema **must** declare
  it; or
- an **entity class** — exposes the default `EntityRepository<Entity>` under `repositoryOf(Entity)`.

Merges into the single `MikroOrmModule` node; call it in every feature module that needs data access.

### `repositoryOf(entity)`

Returns a stable, typed `InjectionToken<EntityRepository<E>>` for an entity that needs no custom
repository class. `repositoryOf(User) === repositoryOf(User)` — the same token provides and injects.
Pair with `register([User])`.

### `MikroOrmInterceptor`

The per-request unit-of-work interceptor. Forks a fresh `EntityManager` into the CLS scope and
`flush()`es it once at the end, only on a successful envelope (no `begin()`; a request that wrote
nothing opens no transaction). Register it in the transport's `configure({ interceptors })` **after**
`ClsInterceptor` — it must run inside the CLS scope.

### Re-exports and factory building blocks

The package re-exports the MikroORM primitives you need, so entities and injection depend on
`@spinejs/mikro-orm` alone: **`MikroORM`**, **`EntityManager`**, **`EntitySchema`**,
**`EntityRepository`**, and the **`Options`** type. For hand-wiring it also exports
**`mikroOrmProvider`**, **`entityManagerProvider`**, and **`connectWithRetry`** (see
[Wiring it by hand](#by-hand)), plus **`DEFAULT_RETRY`**.
