import type { IMigrator, MigrationDiff } from "@mikro-orm/core";

/**
 * Flags accepted by {@link createMigration} — the two generation variants of `migration:create`.
 * Both are off by default (a plain auto-diff). They are forwarded verbatim to MikroORM, which lets
 * `initial` win over `blank` when both are set (an initial migration may itself be blank).
 */
export interface CreateMigrationFlags {
  /** Generate an empty, hand-written migration (the escape hatch) instead of diffing the schema. */
  blank?: boolean;
  /** Generate the first migration for an already-existing schema (baselines the tracking table). */
  initial?: boolean;
}

/**
 * Outcome of {@link createMigration}. `created: false` is the explicit "nothing to do" signal — the
 * auto-diff was empty, so **no file was written and the snapshot was left untouched**. Callers must
 * not treat it as a failure (it is the healthy "schema already matches" case).
 */
export type CreateMigrationResult =
  | { created: true; fileName: string; code: string; diff: MigrationDiff }
  | { created: false; reason: "no-changes" };

/**
 * Pure-function `migration:create` handler (AD-5, AD-10): generates a migration file from the diff
 * between the current entity metadata and the connection's snapshot. It **only writes files, never
 * touches the database** (AD-7) — generation and application are separate verbs.
 *
 * The migration folder and snapshot location come from the `Migrator`'s own connection config (the
 * per-connection `migrations.path` Epic 1 resolves), so no path is passed here — that keeps a named
 * connection writing to its own folder without this leaf knowing connection names (AD-6, AD-10).
 *
 * When the schema already matches the snapshot MikroORM returns an empty `fileName` and writes no
 * file; this surfaces that as `{ created: false, reason: "no-changes" }` so an empty migration never
 * pollutes history (FR-3).
 */
export async function createMigration(
  migrator: IMigrator,
  flags: CreateMigrationFlags = {}
): Promise<CreateMigrationResult> {
  const result = await migrator.createMigration(
    undefined,
    flags.blank ?? false,
    flags.initial ?? false
  );
  if (!result.fileName) {
    return { created: false, reason: "no-changes" };
  }
  return {
    created: true,
    fileName: result.fileName,
    code: result.code,
    diff: result.diff,
  };
}
