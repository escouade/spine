# Product Brief — `@spinejs/mikro-orm` (ORM integration package)

- **Date**: 2026-07-04
- **Status**: Locked — engine (MikroORM), naming, and MVP scope decided; ADR 0016 **Accepted**;
  Gate 0 spike green (`packages/mikro-orm/src/spike.spec.ts`, 4/4).
- **Owner**: John (PM) → integration architecture in ADR 0016 (Winston).
- **Related**: engine bench in [orm-mikro-vs-typeorm-bench.md](./orm-mikro-vs-typeorm-bench.md);
  decision in [ADR 0016](../adr/0016-orm-mikro-orm.md).

## Why (the assumption to validate)

A spine app that needs a database currently wires an ORM by hand: construct the connection, open
it on startup, close it on shutdown, and thread a manager/repository through every service. That
plumbing is repetitive, easy to get wrong (connections that never close, transactions that leak
across requests), and un-idiomatic — it doesn't ride spine's DI, module lifecycle, or CLS.

**Assumption**: developers want an ORM that is _already wired the spine way_ — repositories injected
through the typed DI, connection lifecycle owned by the module, and a **transaction scoped to the
request without threading a manager anywhere**. The package earns its existence only if that last
part (the differentiator) is real; otherwise it is a thin convenience wrapper.

## Who + what they write

Target user: a spine app developer defining entities and data-access services. The package's whole
job is to make the code below _all they write_ — no manual connection handling, no manager
threading, no `.save()` bookkeeping.

```ts
// main.ts — plain Node process
new App([AppModule], {
  /* ... */
});

// app.module.ts
@Module({
  imports: [
    ClsModule,
    MikroOrmModule.configure({
      /* MikroORM options: driver, dbName, entities, retry */
    }),
    UserModule,
  ],
})
export class AppModule {}

// user.repository.ts — the home for custom queries
export class UserRepository extends EntityRepository<User> {
  findByEmail(email: string) {
    return this.findOne({ email });
  }
}

// user.module.ts — register the repos this module exposes
@Module({ imports: [MikroOrmModule.register([UserRepository])] })
export class UserModule {}

// user.service.ts — inject the repo by class token; no manager, no ctx threading
@Injectable({ inject: [UserRepository] })
export class UserService {
  constructor(private readonly users: UserRepository) {}
  async rename(id: string, name: string) {
    const user = await this.users.findOneOrFail({ id });
    user.name = name; // dirty-tracked; committed at request end. No .save().
  }
}
```

Naming is **spine-native, not NestJS**: `configure` (not `forRoot`), `register` (not `forFeature`),
`repositoryOf(Entity)` (not `getRepositoryToken`) for the entity-token path. `configure` reuses
spine's existing dynamic-module convention (`ConfigModule.configure`, `HttpGatewayModule.configure`)
— consistent with the rest of the framework, no foreign or invented vocabulary. Package + module are
scoped to the engine (`@spinejs/mikro-orm` / `MikroOrmModule`), mirroring `@nestjs/typeorm`.

## The differentiator

**A request-scoped EntityManager / unit-of-work, carried by CLS, with zero manager threading.** A
gateway interceptor forks a fresh EntityManager per request and stores it in `ClsService` (ADR 0003).
Every injected `EntityManager` / repository transparently resolves that request's fork (via
`getContext()`). Changes are dirty-tracked and committed once at request end, rolled back on error.
No `Scope.REQUEST` DI cost, no second AsyncLocalStorage. Proven by the Gate 0 spike.

## MVP scope (v1)

In:

1. `MikroOrmModule.configure(options)` — register the ORM once; connection opened on module `onStart`,
   closed on `onStop` (ADR 0010), with **startup retry** (backoff) — a transient DB does not abort boot.
2. `MikroOrmModule.register([Repository])` — expose repositories for a module, injected by class token.
3. `EntityRepository` subclass injection (option A) via typed `inject:` arrays (ADR 0008).
4. **Request-scoped transaction / unit-of-work via CLS** — the differentiator, in v1 (ambitious MVP).
5. A ready-to-register interceptor that opens the per-request scope (mirrors `ClsInterceptor`).
6. **Observability**: bridge MikroORM's logger to the spine logger (`@spinejs/winston-logger`) — one
   sink; connection-lifecycle logs; a failed connect aborts boot cleanly (no half-up), errors never
   swallowed.
7. **Docs (EN + FR)**: usage guide + a **factory escape-hatch page** (wire MikroORM by hand — what
   `configure()` does under the hood) carrying the ⚠️ esbuild / decorator-entity metadata warning.

## Non-goals (v1)

- Multiple DataSources / named connections.
- Migrations CLI / schema-diff tooling (defer; MikroORM ships its own — wrap later if needed).
- A bespoke runtime reconnection loop — connection-loss recovery is delegated to the driver pool and
  documented, not reimplemented.
- Multi-tenant, read replicas, sharding.
- A generic `@spinejs/orm` abstraction over multiple engines — MikroORM only. No premature indirection.

## Success criteria (how we validate the assumption)

- A service mutates an entity and the change persists at request end **without calling `.save()` and
  without receiving any manager/ctx argument**. _(spike ✓)_
- Two concurrent requests never see each other's unit-of-work (CLS isolation holds). _(spike ✓)_
- On a thrown error mid-request, **nothing** is committed (rollback verified). _(spike ✓)_
- Connection opens once on boot (retried on transient failure), closes cleanly on shutdown; a
  permanent connect failure aborts boot cleanly and is logged — the app never starts half-connected.
- ORM logs land in the same sink as the rest of the app.
- A new spine app adds persistence in ≤ the code shown above — no manual connection/transaction code.

## Risks (product angle)

- **Differentiator must actually land.** Kept in v1 and already proven by the spike.
- **Engine bus-factor** (MikroORM, single maintainer) — a supply risk for a core dependency; coupling
  is limited to the `context` hook + standard EM API, keeping an exit reachable.
- **Ambient dependency** — request state (the EM) is invisible in signatures (inherited CLS tradeoff,
  ADR 0003). Mitigate by centralizing scope-open in the provided interceptor.

## Open questions (for implementation)

- How `register([Repository])` maps a repository class to its entity (decorator metadata on the
  entity vs explicit link) — implementation detail.
- Default retry policy values (attempts / delay / backoff) and which pool options to surface.
- Exact spine-logger token/bridge shape for MikroORM's `logger`/`debug` hooks.

_Resolved: engine = MikroORM; the `context`-hook load-bearing fact = verified (spike); package name =
`@spinejs/mikro-orm`._
