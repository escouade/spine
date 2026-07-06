# ADR 0020 — Headless migration command-root (`@spinejs/mikro-orm` migrations)

- **Status**: Accepted
- **Date**: 2026-07-06
- **Scope**: the CLI + programmatic migration surface of `packages/mikro-orm` — `src/migrations/`
  (pure-fn handlers), `src/cli/` (`parse-argv.ts`, `run-migrations.ts`, `bin.ts`, `bin-main.ts`),
  `MigrationRunner` (`mikro-orm.migration-runner.ts`), and the `migrationRunnerRef` token. **No new
  package** (AD-1): the `spine-migrate` bin is a `bin` entry of `@spinejs/mikro-orm`.
- **Relation**: builds on the connection wiring of [ADR 0016](0016-orm-mikro-orm.md) (request-scoped
  EM/UoW) and its Amendment 1 (named connections via `mikroOrmRef(name)`); reuses the two-phase,
  atomic module lifecycle of [ADR 0009](0009-module-loading-two-phases.md)/[ADR 0010](0010-atomic-module-lifecycle.md)
  and the explicit typed DI of [ADR 0007](0007-injection-token-symbol-identity.md)/[ADR 0008](0008-explicit-injection-no-reflect-metadata.md)
  (no service-locator). The `migrations` **config** block + Migrator wiring + per-connection isolation
  are the prior epic (already in `main`); this ADR covers **running** migrations. Numbered 0020 to leave
  0019 for the concurrent OpenAPI work.

## Context

An app configures a connection with `MikroOrmModule.configure({ ..., migrations })`. The developer now
needs to **generate, apply, roll back, and inspect** migrations — from a CLI in dev and CI, and
programmatically from their own scripts. Two forces shape the design.

**One config source (NFR-1).** MikroORM's own CLI reads a standalone `mikro-orm.config.ts`. In a Spine
app the connection is already fully described by the `AppModule` DI graph (driver, `dbName`, entities,
pool, the `migrations` block). A second config file is a thing that drifts. So the CLI must read the
**same `AppModule`** the runtime does — which means booting the real module graph, not re-declaring it.

**Booting the graph must not start the server.** `App.start()` runs every module's `onStart`, and both a
transport's `listen()` and `MikroOrmModule.connect()` live there. A migration run must bind no port and,
ideally, connect only the one connection it targets — not every connection the app configures.

**A programmatic caller must not be killed.** FR-7 wants the same operations callable from a user script.
A surface that calls `process.exit` on failure (as a naïve CLI would) is unusable programmatically — it
takes the caller's process down with it.

## Decision

Three layers, one core, composed by a **headless command-root**.

### 1. Pure-function handlers are the leaf (AD-5, AD-10)

`createMigration` / `up` / `down` / `list` / `pending` in `src/migrations/` take a raw MikroORM
`IMigrator` + parsed flags and import **only** from `@mikro-orm/*`. They contain all verb behavior and no
logging, DI, or process concerns, so the CLI and the programmatic runner share one tested core with no
divergent behavior, and a future `@spinejs/cli` extraction stays open. `createMigration` writes files and
never touches the DB (AD-7); an empty auto-diff surfaces as an explicit "no changes" (no empty file).

### 2. `MigrationRunner` is the injectable surface (FR-7, NFR-5)

Provided per connection — `migrationRunnerRef(name)`, the default under the `MigrationRunner` class token,
only when that connection declared migrations (NFR-4). It wraps the connection's `MikroORM`, delegates
each verb to the leaf handlers, and is the layer that **logs applied/rolled-back migrations per
connection** through the Spine logger. It does **not** own the connection lifecycle — it assumes an
already-connected ORM.

### 3. `runMigrations(AppModule, argv)` is the headless composition-root (FR-4, AD-3)

It parses argv to `{ command, connection, flags }`, composes
`new App([AppModule, MigrationCommandModule.for({ command, connection, flags })])`, and calls
**`app.init()` only — never `start()`**, so no transport binds a port. It **resolves on success and
rejects on failure; it never calls `process.exit`** (AD-5). `app.stop()` in an outer `finally` tears the
rest of the graph down (idempotent with `init()`'s own failure-path stop).

**The command module drives the target connection's lifecycle out-of-band — the load-bearing decision.**
Because `init()`-only never fires `MikroOrmModule.onStart` (where the connection connects), the command
module's `onInit` explicitly runs `connectWithRetry(orm, retry, log)` → the verb → `orm.close(true)` in a
`finally`, decoupled from `MikroOrmModule`'s private `connected` flag. Only the targeted connection is
connected; other configured connections stay constructed-but-idle. On the outer `app.stop()`, the
module's `onStop` sees `connected === false` and skips its own close, so there is no double close.

**The connection reaches the command by concrete-token injection, no `App.get` (AD-4).** A factory
provider injects `[connection === "default" ? MikroORM : mikroOrmRef(connection), loggerToken]` — the
token is known from argv before compose. Because a sibling module cannot see another module's exports
(container resolution is strictly hierarchical, not a flat root), the command module **imports** the
connection to bring that token into its own container and to order its `onInit` after the connection's:
the default connection via the `MikroOrmModule` class node the AppModule's `configure()` populated (shared
by class identity), a named one via its memoized `connectionNode(name)` (the same object `configure({name})`
filled). An unknown `--connection` fails **before composing**, with an actionable list of the configured
migration connections (from the module-scoped registry, populated at AppModule import) — not an opaque
unknown-provider error (FR-10, AD-6).

### 4. The bin is a thin exit-code mapper (AD-1, AD-5)

`bin.ts` (`#!/usr/bin/env node`) is a two-line entry calling `runCli`, which is the **only** place a
migration outcome becomes a `process.exit` code (`0` success / non-zero failure) — so a failing migration
fails a CI build (SM-3) while the handlers and `runMigrations` stay exit-free. `runCli` holds all logic
and never throws, so it is unit-testable. The stable contract is `runMigrations(AppModule, argv)`; the bin
discovers the AppModule with the convenience launcher `--module <path>#<Export>` (default export →
`AppModule` named → sole export).

## Consequences

**Good.** One config source — the CLI and runtime read the same `AppModule`, proven by a test asserting
both boot paths resolve identical driver/db/migrations config (NFR-1). Zero core change: pure
constructor/factory injection, no service-locator, no `App.get`. Programmatic callers are never killed
(FR-7). Only the targeted connection connects. The leaf/runner/root split keeps behavior identical across
the CLI and the API, and keeps a `@spinejs/cli` extraction open.

**Precondition (AD-3).** The headless boot assumes modules do **not** bind external resources in `onInit`
— a Spine invariant the feature depends on, not one it can enforce. A module that opened a socket in
`onInit` would have it opened by a migration run. This is stated verbatim in the `runMigrations`
docstring (`cli/run-migrations.ts`) and this ADR.

**Scope / cost.** The command targets **one** connection per run (no fan-out in v1). The registry that
backs the unknown-connection check is process-global (one App composition per process — the normal CLI
case). Migration **files** are what the runtime must load: the Spine default `emit: "ts"` means a real app
runs the bin under a TS loader (e.g. `tsx`) in dev or against compiled `.js` in prod — a Node runtime
concern documented in the guide, not something the framework can paper over (the test harness sidesteps it
with `emit: "js"` + a CommonJS-marked in-tree folder).

**Alternatives rejected.** A standalone `mikro-orm.config.ts` (a second config source that drifts —
NFR-1). A public `App.get`/`resolve` for the command to fetch the connection (service-locator, violates
ADR 0008/AD-4). One `runMigrations` that both returns and `process.exit`s (unusable programmatically —
split into `runMigrations` + `bin.ts`, AD-5). Connecting via `MikroOrmModule`'s own `connected` flag
(couples the command to module internals and would double-close; the command owns its connect+close).
