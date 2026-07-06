import type { IMigrator, MigrationRow, UmzugMigration } from "@mikro-orm/core";

/**
 * Flags for {@link up} / {@link down} — a single optional target version. `up` without it migrates to
 * the latest pending migration; `down` without it rolls back exactly one. With it, each migrates to
 * that version (`--to`).
 */
export interface VersionFlags {
  /** Migrate up/down **to** this migration version (inclusive), instead of latest / one step. */
  to?: string;
}

// `--to` arrives as a string, but MikroORM/umzug special-case the **number** `0` as "revert everything"
// (`down --to 0`) — a strict `=== 0` check that the string `"0"` fails, yielding an opaque "couldn't
// find migration 0". Coerce the one magic value back to a number; every other version stays a name.
const targetOf = (to: string | undefined): string | number | undefined =>
  to === "0" ? 0 : to;

/**
 * Pure-function `up` handler (AD-5, AD-10): applies **only** pending migrations, in order, recording
 * each in the tracking table. A second run with nothing pending is a no-op (returns `[]`). Batch
 * atomicity (`allOrNothing`, `transactional`) comes from the connection's resolved config (Epic 1);
 * on a failing batch the underlying `up` rejects and this propagates it unchanged so the caller can
 * exit non-zero (NFR-3, FR-5). Returns the migrations applied — the runner logs them (NFR-5).
 */
export async function up(
  migrator: IMigrator,
  flags: VersionFlags = {}
): Promise<UmzugMigration[]> {
  const to = targetOf(flags.to);
  return migrator.up(to !== undefined ? { to } : undefined);
}

/**
 * Pure-function `down` handler (AD-5, AD-10): rolls back the most recent migration, or down **to**
 * `--to <version>` when supplied, running each migration's `down()`. Returns the migrations rolled
 * back — the runner logs them (NFR-5, FR-5).
 */
export async function down(
  migrator: IMigrator,
  flags: VersionFlags = {}
): Promise<UmzugMigration[]> {
  const to = targetOf(flags.to);
  return migrator.down(to !== undefined ? { to } : undefined);
}

/**
 * Pure-function `list` handler (AD-5, AD-10): reports the migrations recorded as executed in this
 * connection's tracking table — exactly one connection, never a merged view (FR-6).
 */
export async function list(migrator: IMigrator): Promise<MigrationRow[]> {
  return migrator.getExecutedMigrations();
}

/**
 * Pure-function `pending` handler (AD-5, AD-10): reports migrations present in this connection's
 * folder but not yet in its tracking table — exactly one connection, never a merged view (FR-6).
 */
export async function pending(migrator: IMigrator): Promise<UmzugMigration[]> {
  return migrator.getPendingMigrations();
}
