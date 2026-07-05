# ADR 0016 — MikroORM for the ORM integration package (`@spinejs/mikro-orm`)

- **Status**: Accepted
- **Date**: 2026-07-04
- **Scope**: new package `packages/mikro-orm`; consumed by gateway transports through their existing
  interceptor hook (ADR 0002), exactly as `@spinejs/cls` is. No change to `packages/core`.
- **Relation**: the request-scoped EntityManager rides the per-request scope of
  [ADR 0003](0003-cls-request-context.md) (CLS) — it does **not** reintroduce the DI request scope
  refused by [ADR 0001](0001-di-provider-scope.md). Repository tokens use
  [ADR 0007](0007-injection-token-symbol-identity.md); injection follows
  [ADR 0008](0008-explicit-injection-no-reflect-metadata.md) (explicit typed `inject:`, no
  `reflect-metadata`). Connection lifecycle uses the module hooks of
  [ADR 0010](0010-atomic-module-lifecycle.md).
- **Evidence**: MikroORM was chosen over TypeORM on a weighted engine comparison (75 vs 56 — the
  scorecard is summarised under _Context_ and _Alternatives_ below); the load-bearing mechanism is
  proven by a runnable spike, `packages/mikro-orm/src/spike.spec.ts` (4/4).

## Context

A spine app that needs a database wires an ORM by hand today: construct the connection, open it on
startup, close it on shutdown, and thread an `EntityManager`/repository through every service that
touches data. The plumbing is repetitive and easy to get wrong — connections that never close,
writes that escape a transaction, request A's manager leaking into request B. None of it rides
spine's DI, module lifecycle, or CLS.

The package earns its existence on **one** capability, not on convenience wrapping: a **transaction /
unit-of-work scoped to the request, with nothing threaded through signatures**. A service mutates an
entity; the change is persisted and committed at request end, rolled back on error — and the service
never receives a manager argument. Everything else (injected repositories, lifecycle) is table
stakes; this is the differentiator.

That capability decides the engine. Two decorator-based TypeScript ORMs were evaluated against
spine's actual constraints (typed `inject:` arrays, no `reflect-metadata`, no param decorators, CLS
for request scope, module-owned lifecycle) — the comparison:

- **TypeORM** has **no identity map and no unit-of-work**; its `EntityManager` is stateless. The
  differentiator would be hand-built (a `QueryRunner` threaded through CLS, an explicit `.save()` at
  every write site — a silent footgun when one is forgotten) or delegated to `typeorm-transactional`,
  which spins **its own** AsyncLocalStorage and monkey-patches the `DataSource` globally — against
  spine's explicit-DI, single-context posture. TypeORM also **mandates** `reflect-metadata` +
  `emitDecoratorMetadata` + `experimentalDecorators`, the exact footprint [ADR 0008](0008-explicit-injection-no-reflect-metadata.md)
  removed, and it clashes with the esbuild / stage-3 / bundler build.
- **MikroORM** has a **native identity map + unit-of-work**, and — decisively — a `context` config
  hook that lets an **external** AsyncLocalStorage own the per-request `EntityManager`. Point it at
  spine's `ClsService` and there is a single ALS (spine's), not two. `reflect-metadata` is optional
  in v6+.

The package is named `@spinejs/mikro-orm` (module `MikroOrmModule`), scoped to the engine rather than
the generic `@spinejs/orm` — mirroring `@nestjs/typeorm` / `@nestjs/mongoose`, and leaving the
generic name free should a second engine ever warrant its own package (see Alternatives).

## Decision

Build `@spinejs/mikro-orm` on **MikroORM**, and make spine's CLS MikroORM's context store so the
request-scoped unit-of-work is the ORM's native behaviour rather than a bolt-on.

### 1. Spine's CLS is MikroORM's context store

`MikroORM.init({ context })` overrides MikroORM's internal AsyncLocalStorage. The package wires it to
`ClsService` (ADR 0003), so one ALS — spine's — backs both:

```ts
const EM = Symbol("orm.em"); // CLS key holding this request's forked EntityManager

MikroORM.init({
  ...options,
  context: () => cls.get(EM), // ← spine CLS resolves the current request's fork
});
```

MikroORM's own `RequestContext` / `@CreateRequestContext` are **not** used — they would run a second,
parallel ALS. The `context` callback replaces them with spine's.

### 2. A per-request fork, opened by an interceptor

The CLS scope is opened once per dispatch by `ClsInterceptor` (ADR 0003). Inside it, a
`MikroOrmInterceptor` (behind the same `GatewayInterceptor` hook, ADR 0002 — `packages/core` stays
untouched) forks a fresh `EntityManager` — one identity map, one unit-of-work — stores it in CLS, and
flushes it once at the end of the dispatch, on a successful envelope:

```ts
async intercept(_route, _ctx, _input, next) {
  const em = this.orm.em.fork(); // fresh identity map + unit-of-work for this request
  this.cls.set(EM, em);
  const res = await next();      // handlers + services run here; their em resolves to this fork
  // The pipeline never throws: business errors come back as { ok: false }. Flush only a successful
  // envelope — flush() wraps the pending changes in ONE implicit transaction (atomic, no explicit
  // .save()). A request that wrote nothing flushes nothing (no transaction opened); an error envelope
  // persists nothing — nothing was ever flushed, so there is nothing to roll back. A failing flush
  // throws out of here and the pipeline maps it to an error code.
  if (res.ok) {
    await em.flush();
  }
  return res;
}
```

There is no up-front `begin()`: deferring to a single end-of-dispatch `flush()` keeps a write atomic
(MikroORM wraps the pending changes in one transaction) while a read-only or DB-free dispatch opens no
transaction and holds no pooled connection across its work.

**Delegation nuance (proven by the spike, not assumed).** `orm.em` — the getter — is **always the
root manager**. It does not itself become the request fork; instead every operation it exposes
(`find`, `persist`, …) delegates to the contextual fork via `getContext()`, which reads the `context`
callback → the CLS fork. So a service injects the `EntityManager` (or a repository) and calls it
normally; the fork resolution is transparent. Identity therefore lives on `orm.em.getContext()`, not
on `orm.em`. The spike asserts exactly this and exercises persist-without-`.save()`, rollback, and
concurrent-request isolation.

### 3. Public API — spine-native names, repository as a class token

The user-facing surface deliberately drops the Angular/NestJS `forRoot`/`forFeature` vocabulary
(opaque — it names nothing) for names that state what they do. `configure` is not a new coinage: it
**reuses spine's existing dynamic-module convention** (`ConfigModule.configure`,
`HttpGatewayModule.configure`), so the ORM module reads like every other spine module rather than
importing foreign vocabulary or inventing a third one:

| Concept                                  | `@spinejs/mikro-orm`                | (NestJS analogue)    |
| ---------------------------------------- | ----------------------------------- | -------------------- |
| configure the connection once, app-level | `MikroOrmModule.configure(options)` | `forRoot`            |
| expose a module's repositories           | `MikroOrmModule.register([...])`    | `forFeature`         |
| entity → repository token                | `repositoryOf(Entity)`              | `getRepositoryToken` |

Repositories are **class tokens** (option A), injected by the class itself — consistent with the
typed `inject:` arrays of ADR 0008, and the natural home for custom queries. `@InjectRepository` (a
parameter decorator reading reflected metadata) is impossible under spine (ADR 0008), so this is not
a stylistic choice — it is the only shape the DI allows, and the typed-token form makes it _safer_
than the NestJS original (a wrong token fails to compile rather than at resolution time):

```ts
// user.repository.ts — the home for custom queries
export class UserRepository extends EntityRepository<User> {
  findByEmail(email: string) {
    return this.findOne({ email });
  }
}

// user.module.ts — register the repos this module exposes
@Module({ imports: [MikroOrmModule.register([UserRepository])] })
export class UserModule {}

// user.service.ts — inject by class token; no manager threaded in, no ctx argument
@Injectable({ inject: [UserRepository] })
export class UserService {
  constructor(private readonly users: UserRepository) {}
  async rename(id: string, name: string) {
    const user = await this.users.findOneOrFail({ id });
    user.name = name; // dirty-tracked; committed at request end. No .save().
  }
}
```

`repositoryOf(Entity)` — an `InjectionToken<EntityRepository<Entity>>` (ADR 0007) — stays available
for entities that need no custom repository, but the class-token form is primary.

### 4. Connection lifecycle on the module class, with startup retry

Lifecycle hooks fire on module classes only, not providers (ADR 0010). `MikroOrmModule` owns the
connection: the `MikroORM` instance is **constructed (not connected)** by a factory provider during
module build, so the actual connect runs in the deterministic lifecycle window (ADR 0010), not at
import time — open on `onStart`, close on `onStop`, in the atomic, reverse-ordered sequence ADR 0010
guarantees.

Connecting is **retried** on startup. A transient DB (a container still booting, a brief network
blip) should not abort the whole app on the first failed attempt. `configure` accepts a retry policy;
`onStart` loops with backoff, and only after the attempts are exhausted does it throw — which ADR
0010 turns into a clean, logged boot abort:

```ts
export class MikroOrmModule implements OnStart, OnStop {
  static inject = [MikroORM, /* spine logger */ Logger] as const;
  constructor(private readonly orm: MikroORM, private readonly log: Logger) {}

  async onStart() {
    // retry: { attempts, delayMs, backoff } — from configure(), with sane defaults
    await connectWithRetry(this.orm, this.retry, this.log);
  }
  async onStop() {
    await this.orm.close(true);
  }
}
```

**Startup retry vs runtime reconnection are different problems, and only the first is ours.** The
retry above covers the _initial_ connect. Losing the connection _while running_ (the DB restarts
mid-traffic) is handled by the driver's connection **pool** (knex, under MikroORM's SQL drivers),
which re-acquires connections per operation. MikroORM exposes no higher-level auto-reconnect, so the
package **surfaces the pool options and documents them** rather than promising a bespoke reconnect it
does not control.

### 5. Observability — one log sink, no swallowed errors

MikroORM has its own `logger` / `debug` config. The module **bridges it to the spine logger**
(`@spinejs/winston-logger`) so ORM output (queries under `debug`, connection events) lands in the
same sink as the rest of the app rather than a second stream. On top of the bridge, the module logs
its own connection lifecycle: connecting, connected, each retry attempt, the final failure, and
close.

Error handling is deliberately thin — the package **surfaces** failures, it does not hide them:

- **Connect failure** after the retry budget → `onStart` throws. ADR 0010 aborts the boot cleanly and
  the fatal is logged. The app does not start half-connected.
- **Write failure** → the end-of-dispatch `flush()` (§2) throws; MikroORM auto-rolls-back its implicit
  transaction, and the throw propagates to the gateway's existing error path (mapped to an error code).
  A business error envelope is simply never flushed — nothing is persisted, nothing to roll back. Either
  way the interceptor never converts a failure into a silent no-op.

### 6. The module is a documented factory, not magic

`MikroOrmModule.configure()` is, under the hood, a small explicit composition — a factory provider
for `MikroORM`, a value provider for the options, the interceptor, and the repository tokens. Nothing
about it is reflective or hidden (ADR 0008). Because it is ordinary spine DI, the **documentation
shows both** the module and the equivalent **hand-written factory** a user can drop into their own
`AppModule` for full control — the same pattern NestJS now documents for custom providers. The module
is the batteries-included path; the factory page is the escape hatch and the transparency.

The docs page carries the one real build gotcha in a prominent warning — it is about **entities**,
not the factory. On the pinned MikroORM **v6**, entity decorators are **legacy-only**
(`experimentalDecorators`) and do **not** work with stage-3 decorators, which spine also targets. The
docs therefore make **`EntitySchema`** (no decorators — what the spike uses) the recommended, portable
entity style; decorator entities are a legacy-only alternative and, lacking `emitDecoratorMetadata`,
need an explicit `type` on every `@Property()`. (MikroORM v7 adds stage-3 decorators via
`@mikro-orm/decorators/es`, still without reflect-metadata — usable once the package moves to v7.) See
the Consequences caution.

## Alternatives considered

### TypeORM

Rejected. No identity map / no unit-of-work, so the package's one reason to exist would be built
against the grain of the ORM — hand-threaded `QueryRunner` + explicit `.save()` everywhere, or
`typeorm-transactional`'s parallel ALS and global `DataSource` patch. Mandatory `reflect-metadata` +
`emitDecoratorMetadata` re-introduce the footprint ADR 0008 removed and clash with the esbuild /
stage-3 build. Bench: 56 vs 75, losing every heavily-weighted dimension. Its wins (driver breadth,
ecosystem size, familiarity) are real but none touch the differentiator.

### MikroORM's own `RequestContext` / `@CreateRequestContext`

Rejected as the scope mechanism. They use MikroORM's internal AsyncLocalStorage, which would run in
parallel to spine's CLS — two ambient contexts to reason about and keep in sync. The `context` hook
(§1) collapses them to one (spine's), which is the whole point of building on top of CLS.

### DI request scope for the `EntityManager` (NestJS `Scope.REQUEST`)

Not reconsidered — settled by ADR 0001 and ADR 0003. A request-scoped provider would put a "request"
notion back into the DI core and re-instantiate a subtree per request. CLS already solved this; the
EM rides it.

### Raw `EntityManager` injection only (no repository classes)

Kept as a secondary path (`inject: [EntityManager]`, then `em.getRepository(Entity)`), but not the
primary API. A repository class per entity (§3) gives custom queries a home and keeps call sites free
of `getRepository` boilerplate.

### A generic `@spinejs/orm` abstracting over multiple engines

Rejected as premature indirection. NestJS ships separate `@nestjs/typeorm`, `@nestjs/mongoose`, etc.
rather than one abstraction, for good reason — the request-scope story is engine-specific (it is
exactly what differs between MikroORM and TypeORM here). This package targets MikroORM only and is
named for it (`@spinejs/mikro-orm`); a second engine, if ever needed, is a second, similarly-named
package.

## Consequences

- **Positive**: the differentiator — request-scoped unit-of-work with no `.save()` and no manager
  threading — was proven by a runnable spike **before** committing to the engine, not asserted from
  docs. `packages/mikro-orm/src/spike.spec.ts` is the executable record.
- **Positive**: entities defined via `EntitySchema` need **no** `reflect-metadata` — the spike runs
  with none — so the package fits ADR 0008 and the esbuild / stage-3 / bundler build without
  exception (see the entity-style caution for the decorator alternative).
- **Positive**: `packages/core` is untouched; the request scope rides the existing interceptor hook,
  exactly like `@spinejs/cls`. The DI model stays `singleton | transient`.
- **Positive**: repository injection is compile-time checked (`repositoryOf(Entity)` is a typed
  `InjectionToken`, ADR 0007) — a wrong token fails to compile, where NestJS resolves at runtime.
- **Positive**: startup is resilient (retry with backoff) and observable (one log sink, lifecycle
  events), and a failed connection aborts the boot cleanly rather than starting half-up.
- **Positive**: `configure()` is an ordinary, inspectable DI composition, so the same wiring is
  available as a documented hand-written factory — no lock-in to the module.
- **Negative**: MikroORM's bus-factor is **1** (a single maintainer, sponsor-funded). This is a real
  supply risk for a core dependency; it is bounded by keeping the coupling to the `context` hook plus
  the standard `EntityManager` API, so an exit stays reachable.
- **Negative**: the request `EntityManager` is an **ambient** dependency — it is not visible in a
  method's parameters (the inherited CLS tradeoff, ADR 0003). Mitigated by centralising the
  scope-open in the provided interceptor.
- **Negative**: the data-mapper model (persist/flush, identity map, fork discipline) is new for
  developers coming from TypeORM's active-record-ish `.save()`.
- **Caution — runtime reconnection is the driver's job**: the module retries the _initial_ connect
  only. Recovery from a connection dropped mid-traffic is delegated to the driver pool and its
  options; the package documents them but does not implement a bespoke reconnect loop.
- **Caution — engine version**: MikroORM **v7 core is published, but the sqlite drivers still cap at
  v6** as of 2026-07-04. The package is pinned to `@mikro-orm/core@^6` + `@mikro-orm/better-sqlite@^6`
  (and any other driver at `^6`). Do **not** mix core v7 with v6 drivers — the peer requirement
  fails. Re-evaluate v7 once the drivers land.
- **Caution — the getter is the root**: `orm.em` returns the **root** manager; the request fork is
  reached via `getContext()`/operation delegation (§2). Code must not cache `orm.em` expecting the
  request fork, nor compare identities against the getter.
- **Caution — entity definition style**: on the pinned MikroORM **v6**, entity decorators are
  **legacy-only** (`experimentalDecorators`) — they do **not** work with stage-3 decorators, which
  spine also targets. `EntitySchema` (no decorators, as the spike uses) is therefore the portable,
  recommended style; decorator entities are a legacy-only alternative and, lacking
  `emitDecoratorMetadata`, need an explicit `type` on every property. MikroORM v7 would add stage-3
  decorators (`@mikro-orm/decorators/es`, still no reflect-metadata) — another reason the v6→v7 move
  matters. The docs (§6) carry this prominently.
- **Caution — a scope must be active**: every entry point needing the EM must run inside a CLS scope
  with a fork set (the provided interceptor). Outside one, `getContext()` has no fork to resolve.

## Amendment 1 — Named multi-connection support (2026-07-05)

- **Status**: Proposed (supersedes the v1 single-connection scope on acceptance).
- **Date**: 2026-07-05.
- **Reverses**: this ADR's implicit single-connection assumption (§4 speaks of _the_ connection,
  singular) and the product brief's "Multiple DataSources / named connections" v1 non-goal.
  Multi-connection surfaced as a base requirement after ship; this amendment brings it back in a
  fully back-compatible, **additive** shape — no change to any single-connection code path.
- **Evidence**: a weighted architecture bench (BMAD architect) across the two decisions this problem
  actually turns on — interceptor topology and partial-failure flush semantics. The winning pair
  (**1B + 2C**, below) is the only one that adds **zero new mechanism** to the shipped
  single-connection path and preserves the lazy-flush differentiator per connection.

### A1.1 Back-compat is the frame, not a footnote

Everything below is additive. The single-connection surface stays **byte-for-byte**: `configure(options)`,
injecting the `MikroORM` / `EntityManager` **class tokens**, `register([Repo])`, `repositoryOf(Entity)`.
The unnamed connection **is** "the default": `mikroOrmRef("default")` resolves — via an `existing`
alias — to the same instance as the `MikroORM` class token, so name-based and class-token code never
see two objects. A codebase that never passes a `name` is unaffected by this amendment.

### A1.2 Topology — one interceptor per connection, chained (bench: 1B)

Each connection yields its **own** `MikroOrmInterceptor`, parameterised by that connection's CLS key;
the transport stacks them explicitly (`[ClsInterceptor, ormMain, ormReplica]`). Rejected alternatives:

- **1A — a single registry-backed interceptor** that forks every registered connection each request.
  It forks all N connections on every dispatch even for a single-DB request, and re-introduces a
  shared mutable registry populated across N `fresh` connection nodes — a build-order coupling that
  fights the isolation `fresh: true` buys ([ADR 0009](0009-module-loading-two-phases.md)).
- **1C — hybrid** (registry-backed single interceptor with per-transport opt-in on which connections
  it brackets). More API surface to freeze for no gain once 2C removes the need for a cross-EM
  coordinator (below).

**1B wins** because it leaves the shipped `[ClsInterceptor, MikroOrmInterceptor]` path unchanged (the
interceptor merely gains a CLS-key parameter defaulting to `EM`), forks **only** each interceptor's own
connection — so a connection a transport does not stack is never even forked, preserving lazy-flush by
construction — and is the most DI-native shape: each interceptor is an explicit provider, explicitly
stacked, explicitly injected by a per-name token, mirroring how `ClsInterceptor` already composes.

**Accepted counter-argument**: 1B gives each interceptor visibility of **only its own** EM, so it
cannot host a cross-EM coordinator — it forecloses emulated two-phase commit. That ceiling is
illusory (MikroORM has no real 2PC — see A1.3), and 2C removes the need for a coordinator entirely.

### A1.3 Flush semantics — write-once per request, opt-in multi-write (bench: 2C)

MikroORM has **no distributed / two-phase commit**: `flush()` is one implicit `begin`+`commit`, and a
commit, once done, cannot be un-done. So no design can make writes to two connections atomic. The
honest move is to make the unsound case **loud**, not to dress it up:

- **Default — at most one connection is written per request.** Each interceptor, on a successful
  envelope, checks whether its fork is dirty (`em.getUnitOfWork().getChangeSets().length > 0`). The
  first dirty connection sets a per-request `WROTE` flag and flushes (one implicit transaction — fully
  atomic, exactly today's guarantee). A **second** dirty connection in the same request **throws** a
  clear error instead of silently committing a partial cross-DB write.
- **Opt-in `multiWrite: true`** (per named connection) lifts the guard for teams that knowingly write
  more than one DB per request. They then get **best-effort sequential** semantics (bench 2A): each
  dirty connection flushes in unwind order; a failure strands whatever already committed. This is
  documented as **"no cross-DB atomicity"** — it is an escape hatch, not a transaction.

Rejected alternative **2B — emulated 2PC** (`begin` all → `flush` all → `commit` all): scored _below_
plain best-effort. It shrinks the failure window to the commit loop but cannot eliminate it (no vote,
no un-commit → commit #1 ok + commit #2 fail still strands a partial write — the same worst case as
2A, mis-advertised as a guarantee), and it **reverses §2's shipped "no up-front `begin()`"**, holding
N transactions open across the whole two-pass window (lock-hold, pool pressure, deadlock surface). A
guarantee you cannot keep is worse than an honest weakness you document.

### A1.4 The composed design (1B + 2C)

The two picks compose without tension precisely because 2C needs **no** cross-EM coordinator — just a
per-request boolean — which 1B's isolated interceptors can share through CLS. Better still, **2C
neutralises 1B's one ergonomic footgun**: since at most one connection is dirty per request by
default, the flush **order** across stacked interceptors (innermost unwinds first) no longer changes
the committed outcome — there is only ever one flush that does work. Order matters again **only** under
the documented `multiWrite` opt-in. Per-connection flush step:

```ts
const em = orm_c.em.fork(); // this connection's fork
cls.set(emKey(c), em); // its own CLS key
const res = await next();
if (res.ok) {
  const dirty = em.getUnitOfWork().getChangeSets().length > 0;
  if (dirty) {
    if (!this.multiWrite && cls.get(WROTE)) {
      throw new Error(
        "@spinejs/mikro-orm: a second connection was written in one request. " +
          "Cross-DB writes have no atomicity; opt in per connection with " +
          "configure({ name, multiWrite: true }) to allow best-effort sequential flush."
      );
    }
    cls.set(WROTE, true);
    await em.flush(); // one implicit transaction — atomic for THIS connection
  }
}
return res;
```

This preserves the shipped no-`begin()` lazy property (§2), the active-scope fail-fast, and — because
`WROTE` is set once and clean forks are a no-op — single-connection behaviour byte-for-byte.

### A1.5 Public API surface (frozen for validation)

- **Tokens**. Default keeps the **class tokens** `MikroORM`, `EntityManager` (back-compat). Named
  connections add memoised, per-name `InjectionToken`s (one token per name, mirroring
  [ADR 0007](0007-injection-token-symbol-identity.md) and the existing `repositoryOf` memoisation):
  `mikroOrmRef(name)`, `entityManagerRef(name)`, `mikroOrmInterceptorRef(name)`. Reserve
  `DEFAULT_CONNECTION = "default"`; `mikroOrmRef("default")` is an `existing` alias of the `MikroORM`
  class token.
- **CLS key scheme**. `emKey(name) = "@spinejs/mikro-orm:em:" + name`; the default connection keeps the
  unchanged shipped key `EM = "@spinejs/mikro-orm:em"`. One write-guard key,
  `WROTE = "@spinejs/mikro-orm:wrote"`, shared by all interceptors in a request.
- **`configure`** — back-compat by omission:
  - `configure(options)` — **unchanged** default: non-`fresh` node, class-token exports; internally
    also registers `mikroOrmInterceptorRef("default")` and the alias.
  - `configure(options & { name: string; multiWrite?: boolean })` — a named connection: a `fresh: true`
    node (so N coexist) owning its **own** `onStart`/`onStop` + retry, exporting
    `mikroOrmRef(name)` / `entityManagerRef(name)` / `mikroOrmInterceptorRef(name)`. `multiWrite`
    defaults `false`.
- **`register`** — `register(items, opts?: { connection?: string })`. `connection` absent = default
  (unchanged); otherwise the repository factories inject `mikroOrmRef(connection)` instead of the
  `MikroORM` class token.
- **`repositoryOf`** — `repositoryOf(entity, connection?)`. Absent = default → **the same token as
  today** (back-compat). Identity becomes `(entity, connection)`: memoisation moves from
  `WeakMap<entity>` to `Map<connection, WeakMap<entity, token>>`.
- **Interceptor** — `MikroOrmInterceptor` gains a CLS-key + `multiWrite` parameter (defaults `EM`,
  `false`). The shipped `@Injectable({ inject: [MikroORM, ClsService, loggerToken] })` stays valid for
  the default; named interceptors come from the per-name factory.

### A1.6 Mandatory leak mitigation

1B's one trap: a connection `configure`d but whose interceptor is **not** stacked on a transport has an
empty CLS key, so its `context: () => cls.get(emKey(name))` hook returns `undefined` and MikroORM
falls back to the **root** `orm.em` — the shared-manager cross-request leak this ADR's Context warns
about, now unflushed. The named `context` hook therefore **must throw** when a CLS scope is active but
its fork is absent, converting a silent leak into a loud "you configured connection _X_ but did not
stack its interceptor" — the same posture as the existing active-scope guard.

### A1.7 Consequences & the one open decision

- **Positive**: single-connection users pay nothing — no new tokens, no guard firing (the `WROTE`
  check never trips with one connection), lazy-flush intact.
- **Positive**: the design refuses the one thing it cannot do (atomic cross-DB writes) **loudly** and
  makes the escape hatch explicit and self-documenting, rather than shipping a partial-commit footgun.
- **Negative**: `multiWrite` delivers only best-effort sequential flush; a mid-sequence failure
  strands earlier commits. Documented, not solved — the correct solution (saga / transactional outbox)
  is out of scope for this package.
- **Negative**: more surface area — three new token constructors, a `name`/`connection`/`multiWrite`
  parameter set, and per-connection lifecycle nodes to test.
- **Open decision for validation**: ship `multiWrite` (best-effort 2A) in this iteration, or leave
  cross-DB writes **unsupported** (guard always on) until a saga/outbox story exists? Architect's lean:
  ship the flag documented as "no cross-DB atomicity" — once the guard exists, the opt-in costs almost
  nothing and unblocks legitimate audit-row / secondary-DB patterns.
