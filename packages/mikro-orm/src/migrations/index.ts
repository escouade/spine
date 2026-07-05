// Pure-function migration handlers — the leaf core (AD-5, AD-10). Every handler takes a raw MikroORM
// `IMigrator` plus parsed flags and imports **only** from `@mikro-orm/*` (never core/gateway/cls), so
// the same tested functions back both the CLI bin and the injectable `MigrationRunner` with no
// divergent behavior, and a future `@spinejs/cli` extraction stays open.
export { createMigration } from "./create";
export type { CreateMigrationFlags, CreateMigrationResult } from "./create";
export { up, down, list, pending } from "./run";
export type { VersionFlags } from "./run";
