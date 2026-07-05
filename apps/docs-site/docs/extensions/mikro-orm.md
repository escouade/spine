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
import type { HttpBaseContext } from "@spinejs/http-gateway";

HttpGatewayModule.configure({
  imports: [ClsModule], // ClsService for the ClsInterceptor
  contextFactory: {
    /* … */
  },
  interceptors: {
    inject: [ClsService, MikroOrmInterceptor],
    factory: (cls: ClsService, orm: MikroOrmInterceptor) => [
      new ClsInterceptor<HttpBaseContext>(cls), // 1. outermost: opens the CLS scope
      // 2. inside the scope: forks the EM + flushes at request end. MikroOrmInterceptor is
      // transport-agnostic, so it drops straight into the slot — no cast.
      orm,
    ],
  },
});
```

`MikroOrmInterceptor` is exported by `MikroOrmModule.configure()` (registered app-level in step 2), so
the interceptor factory resolves it by token. Order matters: `ClsInterceptor` first (it opens the
scope), `MikroOrmInterceptor` after (it writes the fork into that scope).

`MikroOrmInterceptor` is transport-agnostic (it never reads the `ctx` or the route), so its type is the
base `GatewayInterceptor<GatewayContext, …>`. You add it to the `interceptors` array **as-is** — no
cast, no wrapper: a transport's `interceptors` slot is a `ChainInterceptor`, whose union explicitly
admits a transport-agnostic base interceptor alongside a transport-specific one.

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

## Multiple connections

Most apps need one database. When you need more than one — a read replica, a separate analytics or
audit store — give each **additional** connection a `name`. The default connection (no `name`) keeps
the `MikroORM` / `EntityManager` class tokens and everything above unchanged; a named one is injected
through `mikroOrmRef(name)` / `entityManagerRef(name)` and brings its **own** connect/close lifecycle
and retry.

```typescript
// modules/app.module.ts
import { MikroOrmModule } from "@spinejs/mikro-orm";

// The default connection — class tokens, exactly as before.
const primary = MikroOrmModule.configure({
  driver: BetterSqliteDriver,
  dbName: "app.sqlite",
  entities: [UserSchema],
});

// A named connection — its own lifecycle, injected by ref.
const audit = MikroOrmModule.configure({
  name: "audit",
  driver: BetterSqliteDriver,
  dbName: "audit.sqlite",
  entities: [AuditLogSchema],
});
```

Each connection has its **own** interceptor. Stack every one you use on the transport, after
`ClsInterceptor` — each forks its own request `EntityManager` into its own slot, so the connections
never cross request forks:

```typescript
import { ClsInterceptor, ClsModule, ClsService } from "@spinejs/cls";
import {
  MikroOrmInterceptor,
  mikroOrmInterceptorRef,
} from "@spinejs/mikro-orm";

HttpGatewayModule.configure({
  imports: [ClsModule, primary, audit],
  contextFactory: {
    /* … */
  },
  interceptors: {
    // `MikroOrmInterceptor` (class token) is the default connection's; `mikroOrmInterceptorRef("audit")`
    // is the named one. Both are transport-agnostic — they drop into the array as-is, no cast.
    inject: [ClsService, MikroOrmInterceptor, mikroOrmInterceptorRef("audit")],
    factory: (cls, primaryTx, auditTx) => [
      new ClsInterceptor(cls), // 1. opens the CLS scope
      primaryTx, // 2. brackets the default connection's unit-of-work
      auditTx, // 3. brackets the "audit" connection's unit-of-work
    ],
  },
});
```

Bind a feature's repositories to a connection with `register(..., { connection })`, and reach an
entity's default repository on a connection with `repositoryOf(Entity, connection)`:

```typescript
// modules/audit/audit.module.ts
@Module({
  imports: [MikroOrmModule.register([AuditLog], { connection: "audit" })],
})
export class AuditModule {} // inject repositoryOf(AuditLog, "audit")
```

A **custom repository class** is injected by its own class token, which carries no connection — so it
binds to a single connection. To expose one entity on more than one connection, use the **entity-class**
form: `repositoryOf(Entity, connection)` namespaces the token per connection.

### Writing more than one connection in a request

Two databases cannot be written atomically — MikroORM has no two-phase commit, and a committed
transaction cannot be un-done. So by default a request writes **at most one** connection: if a second
connection's unit-of-work is also dirty, the interceptor **throws** — surfacing the unsound
cross-database write loudly instead of letting it pass silently. This is **not** a rollback: interceptors
unwind innermost-first, so the connection that flushed first may already be committed; the throw refuses
the _second_ write.

When you accept that trade-off — say a primary write plus a best-effort audit row — opt **every**
participating connection into `multiWrite` (a single hold-out trips the guard):

```typescript
MikroOrmModule.configure({ name: "audit", multiWrite: true /* … */ });
```

Their units of work then flush **sequentially, best-effort**: if the second flush fails, the first is
already committed. There is **no cross-database atomicity** — reach for a saga / outbox pattern when
you need it. Flush order is the **reverse** of the interceptor array (interceptors unwind
innermost-first): the connection stacked **last** flushes **first**. The opt-in is enforced
order-independently, so this only decides which commit lands first under `multiWrite`, never whether the
guard fires.

:::note
A named connection's `EntityManager` touched inside a request whose interceptor was **not** stacked
throws a wiring diagnostic — it refuses to fall back to a shared, unscoped manager (a cross-request
leak). Stack every connection's interceptor you use.
:::

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

- **No cross-database atomicity.** Multiple connections are supported (see _Multiple connections_), but
  a request writes **at most one** connection unless you opt into `multiWrite` — and even then the
  writes are best-effort sequential, not atomic (MikroORM has no two-phase commit). Reach for a saga /
  outbox pattern when you need a real cross-database transaction.
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

Registers a connection: constructs `MikroORM` at module build, connects on `onStart` (with retry),
closes on `onStop`. With no `name` it is the **default** connection (`MikroORM` / `EntityManager` class
tokens); with a `name` it is an additional connection (`mikroOrmRef(name)` etc.) with its own lifecycle
(see _Multiple connections_). `options` is MikroORM's `Options` (all of it — `driver`, `dbName`,
`entities`, `pool`, `logger`, `debug`, …) plus spine-added fields:

| Option       | Type                   | Default         | Meaning                                                                                |
| ------------ | ---------------------- | --------------- | -------------------------------------------------------------------------------------- |
| `retry`      | `Partial<RetryPolicy>` | `DEFAULT_RETRY` | Startup connect-retry policy (below).                                                  |
| `name`       | `string`               | _(default)_     | Register as a named connection, injected via `mikroOrmRef(name)` / `entityManagerRef`. |
| `multiWrite` | `boolean`              | `false`         | Allow this connection to be written alongside another in one request (best-effort).    |
| _(rest)_     | MikroORM `Options`     | —               | Driver, `dbName`, `entities`, pool, logging.                                           |

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

Call it in every feature module that needs data access. Pass `{ connection }` (the second argument) to
bind the repositories to a **named** connection; omitted, they bind to the default one.

### `repositoryOf(entity, connection?)`

Returns a stable, typed `InjectionToken<EntityRepository<E>>` for an entity that needs no custom
repository class. `repositoryOf(User) === repositoryOf(User)` — the same token provides and injects.
Pair with `register([User])`. `connection` namespaces the token by connection name (identity is
`(entity, connection)`); omitted (or `"default"`) gives the default connection's token.

### `MikroOrmInterceptor`

The per-request unit-of-work interceptor. Forks a fresh `EntityManager` into the CLS scope and
`flush()`es it once at the end, only on a successful envelope (no `begin()`; a request that wrote
nothing opens no transaction). Register it in the transport's `configure({ interceptors })` **after**
`ClsInterceptor` — it must run inside the CLS scope. It is transport-agnostic, so you add it to the
`interceptors` array **as-is** — the slot is a `ChainInterceptor` whose union admits a base
interceptor, so no cast or wrapper is needed.

### Named-connection tokens

`mikroOrmRef(name)`, `entityManagerRef(name)`, and `mikroOrmInterceptorRef(name)` are stable, typed
injection tokens for a named connection's `MikroORM`, request `EntityManager`, and interceptor. Each
memoizes by name — `mikroOrmRef("audit") === mikroOrmRef("audit")` — so a provider and an `inject:`
site share identity. `mikroOrmRef("default")` (the exported `DEFAULT_CONNECTION`) resolves the same
instance as the `MikroORM` class token.

### Re-exports and factory building blocks

The package re-exports the MikroORM primitives you need, so entities and injection depend on
`@spinejs/mikro-orm` alone: **`MikroORM`**, **`EntityManager`**, **`EntitySchema`**,
**`EntityRepository`**, and the **`Options`** type. For hand-wiring it also exports
**`mikroOrmProvider`**, **`entityManagerProvider`**, and **`connectWithRetry`** (see
[Wiring it by hand](#by-hand)), plus **`DEFAULT_RETRY`** and **`DEFAULT_CONNECTION`**.
