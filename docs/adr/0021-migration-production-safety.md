# ADR 0021 — Migration production safety & dev automation (`@spinejs/mikro-orm`)

- **Status**: Accepted
- **Date**: 2026-07-06
- **Scope**: the safe-automation surface of the migrations feature (Epic 3) — `migration:fresh`
  (`src/migrations/fresh.ts` + the CLI policy in `cli/run-migrations.ts`), `migrateOnStart` (in
  `mikro-orm.module.ts`'s connection `onStart`), and the shared fail-closed environment check
  (`mikro-orm.production-safety.ts`). No new package (AD-1).
- **Relation**: realizes **AD-8** (production safety, fail-closed, defense-in-depth) from the migrations
  architecture spine; builds on the pure-fn handlers + `MigrationRunner` + headless command-root of
  [ADR 0020](0020-headless-migration-command-root.md); reuses the per-connection isolation registry of
  the config epic ([ADR 0016](0016-orm-mikro-orm.md) Amendment 1 named connections).

## Context

Two operations are destructive or automatic: `migration:fresh` (drop every table, re-apply from scratch)
and `migrateOnStart` (apply pending migrations while the app boots). Both are genuinely useful in local
development and genuinely dangerous in production — a `fresh` against a production DSN, or an auto-migrate
racing across replicas, is a data-loss incident. The feature must make the dev ergonomics available
without ever letting them fire in production, and without relying on the developer to remember a flag.

The environment signal available is `NODE_ENV`. The naïve check — "refuse when `NODE_ENV === "production"`"
— is **fail-open**: an unset or misspelled env (`prod`, `Production`, empty) sails through the guard.

## Decision

**Fail-closed environment detection, defense-in-depth, and a leaf/guard split.**

1. **Fail-closed `NODE_ENV`.** `isDevelopmentOrTest()` returns true **only** for an exact `development` or
   `test`. Production, any unrecognized label, and unset all refuse — the environment must _prove_ it is
   non-production, never merely fail to prove it is production. One tiny, unit-tested predicate is the
   single source of this rule, shared by both surfaces.

2. **`fresh` — policy in the CLI layer, not the handler (leaf/guard split).** The pure-fn
   `fresh(schema, migrator)` handler imports only `@mikro-orm/*` and does nothing but drop + re-run
   (AD-10). **All policy** lives in `cli/run-migrations.ts:assertFreshAllowed`, enforced **before the app
   is composed or a connection opened**, so a refusal is fail-closed and its diagnostic is never masked by
   a connect error. Three orthogonal gates, each with an actionable message: (a) fail-closed `NODE_ENV`;
   (b) the second, orthogonal `--force-drop` flag — the env label alone never authorizes a drop; (c) the
   target must not share a physical database with another configured connection (flagged at configure
   time by the isolation registry) — a drop cannot be proven to target a distinct database (AD-6).

3. **`migrateOnStart` — in `onStart`, warn-and-skip in production.** It is a **normal-boot** feature: it
   lives in the connection's `onStart` (the `start()` lifecycle) — the default `MikroOrmModule.onStart` and
   the named `NamedMikroOrmConnection.onStart`, after each connects — **never** the headless `runMigrations`
   `init()`-only path (where `onStart` never fires). The two boot paths are never conflated. It is opt-in
   (default off), applies only after a `checkMigrationNeeded()` drift check, and in a non-dev/test env it
   **warns and skips** rather than throwing: the app still boots, it simply never auto-migrates — so a
   misconfigured production deploy degrades to "no auto-migration", not "boot crash".

4. **`migrateOnStart` is a Spine-only key, stripped before MikroORM.** It rides the connection's
   `migrations` block (`MigrationsOptions` adds it; `MikroOrmModuleOptions` overrides MikroORM's
   `migrations` type to carry it) and `resolveMigrationsOptions` strips it before the options reach
   `MikroORM.initSync`, so MikroORM never sees an unknown key. A `migrateOnStartToken` (default connection)
   / the named connection-spec carries it to `onStart`.

## Consequences

**Good.** No migration is ever applied as a side effect of a production boot (NFR-2). The fail-closed
predicate makes an unset/typo'd env safe by default. The leaf/guard split keeps the destructive handler
pure and testable while all refusals are enforced before the database is touched. `fresh` needs two
independent confirmations (env **and** `--force-drop`) plus a distinct-database proof, so no single
mistake drops a shared or production database. Warn-and-skip means a production misconfiguration never
takes the app down.

**Cost / limits.** There is **no advisory lock** — `migrateOnStart` must never run where replicas could
race the same database; production applies migrations explicitly (`spine-migrate migration:up`), once,
before rollout. `NODE_ENV` labels the _environment_, not the _database_: it is defense-in-depth, which is
why `fresh` also requires `--force-drop` and the operator owns confirming the DSN's target. `migrateOnStart`
on a shared-physical connection is not specially refused (only `fresh` is) — but it is non-destructive and
still env-gated.

**Alternatives rejected.** Fail-open "refuse only `NODE_ENV==="production"`" (an unset env would auto-run —
the exact footgun). Policy inside the pure `fresh` handler (couples the leaf to env/CLI concerns, breaks
AD-10, and can't refuse before connecting). `migrateOnStart` on the headless `runMigrations` path (it runs
`init()` only; `onStart` never fires there — the feature would silently never fire). Throwing on a
production `migrateOnStart` (a misconfig would crash the boot rather than degrade safely).
