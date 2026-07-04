---
stepsCompleted:
  [
    "step-01-validate-prerequisites",
    "step-02-design-epics",
    "step-03-create-stories",
    "step-04-final-validation",
  ]
inputDocuments:
  - docs/plans/orm-package-brief.md
  - docs/adr/0016-orm-mikro-orm.md
  - docs/plans/orm-mikro-vs-typeorm-bench.md
---

# @spinejs/mikro-orm — Epic Breakdown

## Overview

This document provides the complete epic and story breakdown for the `@spinejs/mikro-orm` package,
decomposing the requirements from the product brief and the Accepted architecture decision (ADR 0016)
into implementable stories.

> **Note on inputs.** There is no canonical `PRD.md` / `Architecture.md` — by design (lean scoping
> for a single framework package). Their equivalents are the **product brief**
> (`docs/plans/orm-package-brief.md` = requirements/scope) and **ADR 0016**
> (`docs/adr/0016-orm-mikro-orm.md` = Accepted architecture). The Gate 0 spike
> (`packages/mikro-orm/src/spike.spec.ts`, 4/4) already proved the load-bearing mechanism. No UX
> document — the package has no UI.

## Requirements Inventory

### Functional Requirements

FR1: `MikroOrmModule.configure(options)` registers a single MikroORM connection once at app level;
the `MikroORM` instance is constructed at module build (a factory provider) and connected on module
`onStart`, closed on `onStop` (ADR 0010 atomic lifecycle).

FR2: `configure` accepts a startup retry policy (`retry: { attempts, delayMs, backoff }`); a transient
connect failure is retried with backoff, and only after the budget is exhausted does `onStart` throw
— aborting boot cleanly rather than starting half-connected.

FR3: `MikroOrmModule.register([Repository])` exposes a module's repositories, each injectable by its
class token within that module.

FR4: Repositories are `EntityRepository<Entity>` subclasses injected by class token via typed
`inject:` arrays (ADR 0008); `repositoryOf(Entity)` provides an `InjectionToken` for entities that
need no custom repository class.

FR5: A gateway interceptor (`MikroOrmInterceptor`, behind the ADR 0002 hook, running inside the CLS
scope of ADR 0003) forks a fresh `EntityManager` per request, stores it in `ClsService`, and brackets
the dispatch: `begin` → `commit` on success, `rollback` on error.

FR6: An injected `EntityManager` / repository transparently resolves the current request's fork (via
`getContext()`); a service persists entity mutations at request end with **no `.save()`** and **no
threaded manager/ctx argument**.

FR7: The module bridges MikroORM's `logger`/`debug` output to the spine logger
(`@spinejs/winston-logger`) — a single sink — and logs its own connection lifecycle (connecting,
connected, retry attempt N, final failure, closing).

FR8: Documentation (EN **and** FR): a usage guide + a **factory escape-hatch page** showing the
equivalent hand-written MikroORM wiring (what `configure()` does under the hood), carrying a
prominent ⚠️ esbuild / decorator-entity metadata warning; plus a package `README`.

### NonFunctional Requirements

NFR1: No `reflect-metadata`. On the pinned MikroORM **v6**, entity decorators are **legacy-only**
(`experimentalDecorators`) and do **not** work with stage-3 decorators — which spine also targets
(ADR 0008). The **portable, recommended entity style is `EntitySchema`** (no decorators — what the
spike uses). Decorator entities are a legacy-only option and, lacking `emitDecoratorMetadata`, need an
explicit `type` on every property. (MikroORM v7 would add stage-3 decorators via
`@mikro-orm/decorators/es`, still without reflect-metadata — usable once the package moves to v7.)

NFR2: `packages/core` is not modified. The request scope rides the existing interceptor hook; the DI
model stays `singleton | transient` (no DI request scope — ADR 0001).

NFR3: Concurrent requests are isolated — no unit-of-work / identity-map cross-contamination (CLS
binds to the async context, not an instance). _(spike ✓)_

NFR4: Errors are never swallowed — the interceptor rethrows after rollback; a permanent connect
failure aborts boot and is logged.

NFR5: A single `AsyncLocalStorage` (spine's CLS). MikroORM's internal `RequestContext` /
`@CreateRequestContext` are not used; the `context` config hook points at `ClsService`.

NFR6: Repository injection is compile-time checked (typed `InjectionToken` / class tokens) — a wrong
token fails to compile, not at runtime.

NFR7: Engine pinned to MikroORM **v6** (core + driver aligned, e.g. `@mikro-orm/core@^6` +
`@mikro-orm/better-sqlite@^6`). Core v7 must not be mixed with v6 drivers.

NFR8: The package mirrors existing spine package conventions (ESM, `main`/`types` → `src/index.ts`,
`tsup` build + `publishConfig`, `vitest`, nx `typecheck`/`test`/`build` targets); `yarn lint:all &&
typecheck:all && test:all` clean.

### Additional Requirements

- **No from-scratch scaffold**: `packages/mikro-orm` already exists (package.json, tsconfig,
  project.json, vitest.config, src/index.ts placeholder) and the Gate 0 spike is green. Story 0 is
  build/export wiring (tsup config, `publishConfig`, real `src/index.ts` barrel, README stub), not a
  new package.
- **Runtime reconnection is out of scope to implement** — connection-loss recovery is delegated to
  the driver pool; the package surfaces and documents pool options only (ADR 0016 §4, Consequences).
- **Naming is fixed**: `configure` / `register` / `repositoryOf` (ADR 0016 §3). Do not reintroduce
  `forRoot`/`forFeature`/`connect`.
- **Delegation nuance** (ADR 0016 §2): `orm.em` (getter) is the root manager; the request fork is
  reached via `getContext()`. Tests and code assert identity on `orm.em.getContext()`.

### UX Design Requirements

N/A — the package has no UI. No UX design contract.

### FR Coverage Map

FR1: Epic 1 — `MikroOrmModule.configure()` registers the connection; construct-at-build, connect on
`onStart`, close on `onStop`.
FR2: Epic 1 — startup connection retry with backoff; clean boot abort on exhaustion.
FR3: Epic 1 — `MikroOrmModule.register([Repository])` exposes a module's repositories.
FR4: Epic 1 — `EntityRepository` class-token injection via typed `inject:`; `repositoryOf(Entity)`.
FR5: Epic 1 — `MikroOrmInterceptor` forks a per-request `EntityManager` into CLS, brackets the
dispatch in a transaction.
FR6: Epic 1 — transparent fork resolution (`getContext()`); persist mutations at request end with no
`.save()` and no threaded manager.
FR7: Epic 1 — bridge MikroORM logging to the spine logger; connection-lifecycle logs.
FR8: Epic 1 — docs (EN + FR): usage guide + factory escape-hatch page (esbuild/entity warning) + README.

## Epic List

### Epic 1: Idiomatic persistence with request-scoped transactions

A spine app developer adds a database and persists domain data **the spine way**: define entities and
repositories, register the connection once, and get a transaction / unit-of-work scoped to each
request — repositories injected through the typed DI (ADR 0008), connection lifecycle owned by the
module (ADR 0010), the per-request unit-of-work carried by CLS (ADR 0003), and ORM output flowing
through the app's logger. No hand-wired ORM, no threaded manager, no `.save()` bookkeeping. A failed
connection is retried on startup and, if permanent, aborts boot cleanly rather than starting half-up.

**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR6, FR7, FR8

_Single epic by design: one cohesive component (the package), every requirement touches the same
files, and the architecture is fully validated (ADR 0016) with the load-bearing mechanism already
proven (Gate 0 spike) — no risk boundary that would justify splitting. Delivered as ordered stories
within the epic (step 3)._

## Epic 1: Idiomatic persistence with request-scoped transactions

A spine app developer adds a database and persists domain data the spine way: entities and
repositories via the typed DI, a connection configured once and owned by the module lifecycle, and a
transaction / unit-of-work scoped to each request through CLS — no hand-wired ORM, no threaded
manager, no `.save()`. Stories are ordered; none depends on a later one.

### Story 1.1: Package builds and exposes a public entry

As a package maintainer,
I want `@spinejs/mikro-orm` to build and expose a public API barrel like the other spine packages,
So that consumers can import it and the release pipeline can publish it.

**Acceptance Criteria:**

**Given** the package with a `tsup` build and `publishConfig` mirroring `@spinejs/cls`
**When** `nx build mikro-orm` runs
**Then** it emits `dist/` with ESM, CJS, and `.d.ts` outputs and no error.

**Given** `packages/mikro-orm/src/index.ts`
**When** inspected
**Then** it is an explicit named barrel (no `export *`), initially minimal, that later stories extend
with each public symbol they add.

**Given** the monorepo
**When** `nx typecheck mikro-orm` runs
**Then** it passes, and a `README` stub exists (name, one-line description, install).

### Story 1.2: Configure the connection with owned lifecycle and startup retry

As a spine app developer,
I want `MikroOrmModule.configure(options)` to open the database when the app starts and close it when
it stops, retrying transient failures,
So that I get a managed connection without hand-wiring lifecycle.

**Acceptance Criteria:**

**Given** `MikroOrmModule.configure({...})` in `AppModule` imports
**When** the app starts
**Then** a `MikroORM` instance is constructed at module build and its `connect()` runs in `onStart`;
`close()` runs in `onStop` (ADR 0010), exactly once each.

**Given** a `retry: { attempts, delayMs, backoff }` option and a transient connect failure
**When** the app boots
**Then** connect is retried with backoff up to `attempts` before succeeding.

**Given** connect fails past the retry budget
**When** the app boots
**Then** `onStart` throws and boot aborts cleanly (ADR 0010) — the app never starts half-connected.

**And** with no `retry` option, a documented default policy applies.

### Story 1.3: Request-scoped transactional EntityManager (the differentiator)

As a spine app developer,
I want each request to get its own transactional `EntityManager` via CLS,
So that my services persist changes at request end without threading a manager or calling `.save()`.

**Acceptance Criteria:**

**Given** a registered `MikroOrmInterceptor` running inside the CLS scope (ADR 0003)
**When** a dispatch runs
**Then** a forked `EntityManager` is stored in CLS and the dispatch is bracketed by `begin` →
`commit` (flush) on success.

**Given** a service that injects `EntityManager` and mutates a loaded entity
**When** the request completes
**Then** the change is committed with **no explicit `.save()`** and no manager passed to the service.

**Given** a handler throws mid-request
**When** the request fails
**Then** the transaction is rolled back, nothing is persisted, and the error is rethrown.

**And** two concurrent requests each see their own fork (no cross-contamination), and `orm.em.getContext()`
inside a scope resolves to that request's fork.

### Story 1.4: Repositories — register and inject by class token

As a spine app developer,
I want to define repository classes and inject them by class token,
So that data access has a typed home without `@InjectRepository`.

**Acceptance Criteria:**

**Given** `class UserRepository extends EntityRepository<User>` and
`MikroOrmModule.register([UserRepository])` in a feature module
**When** a provider declares `inject: [UserRepository]`
**Then** it receives a repository bound to the current request's `EntityManager`.

**Given** a custom method on the repository (e.g. `findByEmail`)
**When** called inside a request
**Then** it runs against the request fork and respects the active transaction.

**Given** an entity with no custom repository class
**When** a provider declares `inject: [repositoryOf(User)]`
**Then** it receives a typed `EntityRepository<User>`.

**And** a wrong token type in an `inject:` array fails to compile (typed tokens, ADR 0007/0008).

### Story 1.5: One log sink and surfaced errors

As a spine app developer,
I want the ORM's logs in my app's logger and failures surfaced rather than swallowed,
So that I can observe and debug persistence.

**Acceptance Criteria:**

**Given** the spine logger (`@spinejs/winston-logger`) is available
**When** MikroORM logs (queries under `debug`, connection events)
**Then** output flows through the spine logger — one sink, not a second stream.

**Given** the connection lifecycle
**When** the app starts, retries, fails, or stops
**Then** connecting / connected / retry attempt N / final failure / closing are logged accordingly.

**Given** a transaction rollback (Story 1.3)
**When** it happens
**Then** the error is rethrown (never swallowed); the rollback may be debug-logged.

**And** when no logger is available the module degrades gracefully (no crash).

### Story 1.6: Integration tests over the real module API

As a package maintainer,
I want integration tests exercising the public module API (not just the raw spike),
So that the differentiator and lifecycle are protected against regressions.

**Acceptance Criteria:**

**Given** a test app wired with `MikroOrmModule.configure` + `register` on sqlite in-memory
**When** it boots
**Then** the connection opens and repositories inject and resolve the request fork.

**Given** request-simulating tests through the real interceptor
**When** they run
**Then** persist-without-`.save()`, rollback-on-error, and concurrent-request isolation all pass.

**Given** the retry policy
**When** a transient failure is simulated
**Then** it is retried, and a permanent failure aborts boot.

**And** `nx test mikro-orm` is green and the Gate 0 spike still passes.

### Story 1.7: Documentation (EN + FR) with a factory escape-hatch page

As a spine app developer,
I want a usage guide and a hand-wiring factory page in both languages,
So that I can add persistence idiomatically and understand the build constraints.

**Acceptance Criteria:**

**Given** the docs site
**When** built (`cd apps/docs-site && yarn build`)
**Then** a MikroORM usage page exists in **EN and FR**, following the pedagogical order
(`main.ts → module → repository → service`), with valid links/anchors.

**Given** the factory escape-hatch page
**When** read
**Then** it shows the hand-written provider equivalent of `configure()` and carries the prominent ⚠️
warning: `EntitySchema` is the recommended entity style; decorators are legacy-only on v6 and need an
explicit `type` (no `emitDecoratorMetadata`).

**Given** CLAUDE.md doc rules
**When** the docs land
**Then** EN and FR are in sync, the `README` documents install + quick start + links, and touched
files are `prettier`-formatted.
