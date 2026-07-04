# Bench — MikroORM vs TypeORM for the SpineJS ORM package

- **Date**: 2026-07-04
- **Purpose**: decision input for ADR 0016 (ORM engine for the future `@spinejs/mikro-orm` package).
- **Verdict**: **MikroORM**, confidence **high** (weighted 75 vs 56).
- **Note on naming**: code sketches below use `forRoot`/`forFeature` for familiarity; the
  package (`@spinejs/mikro-orm`) exposes spine-native names — `MikroOrmModule.configure(...)`,
  `MikroOrmModule.register([...])`, `repositoryOf(Entity)` (PM decision). Mechanics are unchanged.

Scored through spine's actual integration constraints (not generically):

- DI is explicit typed `inject:` arrays, positional, compile-checked. No `@Inject()` param
  decorator, no `reflect-metadata`, no string tokens (see ADR 0008). `@InjectRepository` is
  therefore impossible; repos inject by class-token.
- Request scope is CLS (`AsyncLocalStorage`), not a DI request scope (ADR 0001, ADR 0003).
- Killer feature = a request-scoped `EntityManager` / unit-of-work stored in CLS.
- Module-class lifecycle (`OnStart`/`OnStop`) drives `initialize()` / `destroy()` (ADR 0010).

## 1. Scorecard

| Dimension (weight)                                                                   | MikroORM                                                                                                                                                                                                             | TypeORM                                                                                                                                                            |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Request-scoped UoW / identity-map / per-request EM fit with CLS (×3)**             | **5** — native identity-map + UoW + dirty-tracking + `flush()`; `em.fork()` = per-request scope; `MikroORM.init({ context })` makes spine CLS the store; `orm.em` auto-resolves the request fork via `getContext()`. | **2** — no identity-map, no UoW, no dirty-tracking; `EntityManager` is stateless. Best native = transaction-per-request with explicit `.save()`.                   |
| **Fit with spine DI (typed inject, no param decorators, no reflect-metadata) (×2)**  | **4** — inject `EntityManager`/`MikroORM` as class tokens; contextual fork resolves through CLS; repos via `em.getRepository(E)`. reflect-metadata optional in v7.                                                   | **3** — inject `DataSource`, derive repos via `getRepository(E)`; mechanically fine but repos are root-bound and ecosystem assumes `@InjectRepository`/reflection. |
| **Transaction API ergonomics for a CLS `@Transactional()`/`withTransaction()` (×2)** | **5** — `em.transactional(cb)`, `em.begin/commit/rollback`, built-in `@Transactional()` with 7 propagation modes, flush-before-commit, respects contextual fork.                                                     | **3** — `dataSource.transaction(cb)` or manual `QueryRunner`; propagation + CLS need 3rd-party `typeorm-transactional` (global patch) or DIY.                      |
| **TS type quality / inference (×2)**                                                 | **5** — v7 tracks joined aliases via generics, type-safe partial-loading, ~40% fewer type instantiations; best-in-class.                                                                                             | **3** — historically loose (find-options, partial selects, relations); improved in 1.0 but trails.                                                                 |
| **Maintenance health (cadence/governance/funding/bus-factor) (×2)**                  | **4** — very active (v7 GA 2026-03, v7.1 out), but **bus-factor = 1** (solo maintainer, sponsors).                                                                                                                   | **4** — revived late-2024 by a _team_ (~8 maintainers) + planned foundation; v1.0 2026-06. Stronger bus-factor, revival track record <2 yrs.                       |
| **ESM / modern module support (×1)**                                                 | **5** — v7 native ESM, no reflect-metadata; clean under `esnext`/`bundler`.                                                                                                                                          | **3** — supports ESM but CLI/migration edge cases; **requires** `experimentalDecorators`+`emitDecoratorMetadata`.                                                  |
| **Migrations tooling (×1)**                                                          | **4** — migrator + schema-diff + entity generator.                                                                                                                                                                   | **4** — mature, widely used; ESM migration-gen edge bugs.                                                                                                          |
| **Driver / DB breadth (×1)**                                                         | **4** — 8 DBs incl. Mongo, libSQL, Oracle (v7).                                                                                                                                                                      | **5** — broadest (PG, MySQL, MariaDB, SQLite, MSSQL, Oracle, CockroachDB, SAP Hana, Mongo, Spanner…).                                                              |
| **Ecosystem / adoption / SO / hiring (×1)**                                          | **3** — growing, good docs, smaller footprint.                                                                                                                                                                       | **5** — ~2M weekly downloads, huge SO corpus, NestJS default.                                                                                                      |
| **Learning curve for a TypeORM dev (×1)**                                            | **3** — new model (data-mapper, persist/flush, identity-map, forking).                                                                                                                                               | **5** — it's TypeORM.                                                                                                                                              |
| **Deps / install weight / reflect-metadata (×1)**                                    | **5** — v7 zero core runtime deps, no reflect-metadata.                                                                                                                                                              | **2** — mandatory `reflect-metadata` + `emitDecoratorMetadata` + `experimentalDecorators`.                                                                         |

**Weighted totals (max 85): MikroORM 75 · TypeORM 56.** MikroORM wins every ×2/×3 dimension;
TypeORM's wins are all ×1 (drivers, ecosystem, learning curve).

## 2. The differentiator, concretely

### MikroORM — spine CLS _is_ the context store (flows)

Key: `MikroORM.init({ context })` overrides MikroORM's own `AsyncLocalStorage`. Point it at spine's
`ClsService` and you never touch MikroORM's `RequestContext` — no second/parallel ALS. Every injected
`orm.em` auto-resolves the request fork via `getContext()`.

```ts
// orm.module.ts — lifecycle on the MODULE class (OnStart/OnStop)
import { MikroORM, EntityManager, type Options } from "@mikro-orm/postgresql";
import { ClsService } from "@spinejs/cls";

const EM = Symbol("orm.em"); // CLS key holding the per-request fork

export class OrmModule implements OnStart, OnStop {
  static forRoot(config: Options) {
    return {
      module: OrmModule,
      providers: [
        {
          provide: MikroORM,
          inject: [ClsService],
          // initSync = construct but DON'T connect yet; connect in onStart
          useFactory: (cls: ClsService) =>
            MikroORM.initSync({
              ...config,
              context: () => cls.get<EntityManager>(EM),
            }),
        },
        // inject EntityManager anywhere -> orm.em delegates to getContext() -> request fork
        {
          provide: EntityManager,
          inject: [MikroORM],
          useFactory: (o: MikroORM) => o.em,
        },
      ],
    };
  }
  static inject = [MikroORM] as const;
  constructor(private orm: MikroORM) {}
  async onStart() {
    await this.orm.connect();
  } // dataSource.initialize() equivalent
  async onStop() {
    await this.orm.close();
  } // .destroy() equivalent
}
```

```ts
// orm.interceptor.ts — runs INSIDE the gateway's cls.run() per request
// One fork = one identity-map = one UnitOfWork = one transaction.
export class OrmContextInterceptor {
  static inject = [MikroORM, ClsService] as const;
  constructor(private orm: MikroORM, private cls: ClsService) {}

  async intercept(_ctx: unknown, next: () => Promise<unknown>) {
    const em = this.orm.em.fork(); // fresh identity map + UoW for this request
    this.cls.set(EM, em); // spine CLS now backs MikroORM's context
    await em.begin();
    try {
      const res = await next(); // handlers/services see this em via getContext()
      await em.commit(); // flush() the UoW, then COMMIT
      return res;
    } catch (e) {
      await em.rollback(); // discard; identity map dies with the scope
      throw e;
    }
  }
}
```

```ts
// user.service.ts — no manager threading, no explicit save; pure UnitOfWork
export class UserService {
  static inject = [EntityManager] as const; // resolves to the REQUEST fork automatically
  constructor(private em: EntityManager) {}
  async rename(id: string, name: string) {
    const user = await this.em.findOneOrFail(User, { id });
    user.name = name; // dirty-tracked; flushed at commit. No .save().
  }
}
```

`RequestContext` vs spine CLS: MikroORM's `RequestContext.create()` / `@CreateRequestContext` use
MikroORM's _internal_ ALS — which would run **parallel** to spine's CLS. The `context` callback
sidesteps that entirely: one ALS (spine's), MikroORM reads from it. Cooperation, verified.

### TypeORM — must thread the manager by hand (fights)

No `getContext()`. No UoW. Repos injected as tokens bind to the **root** DataSource, so
`@InjectRepository`-style injection is actively _wrong_ under a request transaction — a silent
footgun where writes escape the tx.

```ts
// orm.module.ts
import { DataSource, type DataSourceOptions, EntityManager } from "typeorm";
export class OrmModule implements OnStart, OnStop {
  static forRoot(opts: DataSourceOptions) {
    return {
      module: OrmModule,
      providers: [
        { provide: DataSource, useFactory: () => new DataSource(opts) },
      ],
    };
  }
  static inject = [DataSource] as const;
  constructor(private ds: DataSource) {}
  async onStart() {
    await this.ds.initialize();
  }
  async onStop() {
    await this.ds.destroy();
  }
}
```

```ts
// orm.interceptor.ts — transaction-per-request via QueryRunner in CLS
const QR = Symbol("orm.qr");
export class OrmContextInterceptor {
  static inject = [DataSource, ClsService] as const;
  constructor(private ds: DataSource, private cls: ClsService) {}
  async intercept(_c: unknown, next: () => Promise<unknown>) {
    const qr = this.ds.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    this.cls.set(QR, qr);
    try {
      const res = await next();
      await qr.commitTransaction(); // nothing auto-persists — every change was an explicit .save()
      return res;
    } catch (e) {
      await qr.rollbackTransaction();
      throw e;
    } finally {
      await qr.release();
    }
  }
}
```

```ts
// EVERY data-access site must fetch the tx manager or it silently escapes the transaction:
const em = (cls: ClsService, ds: DataSource): EntityManager =>
  cls.get<QueryRunner>(QR)?.manager ?? ds.manager;

export class UserService {
  static inject = [ClsService, DataSource] as const;
  constructor(private cls: ClsService, private ds: DataSource) {}
  async rename(id: string, name: string) {
    const m = em(this.cls, this.ds); // must remember, everywhere
    const user = await m.findOneByOrFail(User, { id });
    user.name = name;
    await m.save(user); // explicit; no dirty-tracking, no flush
  }
}
```

To get real dirty-tracking/propagation you'd adopt `typeorm-transactional` — which spins **its own
ALS** (parallel to spine CLS) and globally patches the DataSource via
`initializeTransactionalContext()` + `addTransactionalDataSource()`. That contradicts spine's
explicit-DI, single-context posture.

## 3. Key risks

**MikroORM**

1. **Bus-factor = 1.** One maintainer, free-time + sponsors. Continuity risk for a core dependency.
2. **New surface + steeper model.** v7 GA'd 2026-03 (early-adopter edges); persist/flush ordering,
   identity-map staleness, and forking discipline are new concepts users must internalize.

**TypeORM**

1. **Architectural mismatch with the differentiator.** No identity-map/UoW; the flagship feature is
   hand-rolled or delegated to a global-monkey-patching ALS lib — building spine's headline package
   _against the grain_ of the ORM.
2. **reflect-metadata + legacy decorators are mandatory** — reintroduces the exact footprint spine
   removed (ADR 0008) and clashes with the ESM/stage-3/bundler tsconfig. (Revived-maintenance
   track record still <2 yrs.)

## 4. Recommendation

**Pick MikroORM. Confidence: high** — for spine's thesis (a request-scoped UnitOfWork is _the_
differentiator). 75 vs 56; wins every ×2/×3 dimension; its `context` hook makes spine's CLS a
first-class citizen rather than a competitor to a second ALS.

**The one fact that flips it:** if a request-scoped **UnitOfWork/identity-map is not actually the
package's core value** (team content with explicit `.save()` + transaction-per-request), the ×3
advantage evaporates and TypeORM's ecosystem, hiring familiarity, driver breadth, and multi-maintainer
governance win. (Secondary flip: if bus-factor-1 is judged an unacceptable long-term risk regardless.)

## Sources

- MikroORM v7 (zero deps, ESM, reflect-metadata optional, 8 DBs, GA 2026-03-11):
  https://mikro-orm.io/blog/mikro-orm-7-released · https://mikro-orm.io/docs/upgrading-v6-to-v7 · https://mikro-orm.io/changelog
- MikroORM RequestContext / `context` option / `em.fork()` / `getContext()`: https://mikro-orm.io/docs/identity-map
- MikroORM transactions / `@Transactional()` / propagation: https://mikro-orm.io/docs/transactions · https://mikro-orm.io/api/core/function/Transactional
- MikroORM single maintainer / funding: https://github.com/sponsors/B4nan · https://github.com/mikro-orm/mikro-orm
- TypeORM 1.0 (2026-06-05), new maintainers, 2025 stats: https://www.infoq.com/news/2026/06/typeorm-1-released/ · https://typeorm.io/blog/typeorm-1-0/
- TypeORM governance / foundation / team: https://typeorm.io/docs/future-of-typeorm/ · https://typeorm.io/maintainers/
- TypeORM requires reflect-metadata + experimentalDecorators + emitDecoratorMetadata: https://typeorm.io/docs/getting-started/
- TypeORM has no identity-map / no unit-of-work: https://github.com/typeorm/typeorm/issues/677 · https://betterstack.com/community/guides/scaling-nodejs/typeorm-v-mikroorm/
- `typeorm-transactional` (ALS, global DataSource patch): https://github.com/Aliheym/typeorm-transactional
