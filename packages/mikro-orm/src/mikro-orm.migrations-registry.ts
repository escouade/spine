import { resolve } from "node:path";
import type { Options } from "@mikro-orm/core";
import { DEFAULT_RETRY, type RetryPolicy } from "./mikro-orm.options";

// MikroORM's own defaults for a connection that declares neither key — the effective values two
// connections would silently share if nothing namespaced them apart.
const MIKRO_ORM_DEFAULT_PATH = "./migrations";
const MIKRO_ORM_DEFAULT_TABLE = "mikro_orm_migrations";

/** The effective migration coordinates a connection resolves to (used for collision detection). */
interface MigrationConnectionInfo {
  /** Absolute, normalized migrations folder — so `./migrations`, `migrations`, and `./migrations/` compare equal. */
  path: string;
  host: string | undefined;
  dbName: string | undefined;
  tableName: string;
  /** Set when another connection shares this one's physical DB (host+dbName) — Story 3.1 refuses `fresh`. */
  sharedPhysical: boolean;
  /** The connection's resolved startup retry policy, so the migration CLI connects like the app does. */
  retry: RetryPolicy;
}

// Module-scoped registry of configured migration connections, keyed by connection name. It is populated
// at configure() time — the one place with cross-connection visibility, since each configure() call
// registers a single connection.
//
// SCOPE: the registry reasons over every connection configured in the process, so it assumes **one App
// composition per process** — the normal case (an app boot, or the one-shot migration CLI). A process
// that composes two independent Apps must call `resetMigrationRegistry()` between them; there is no
// automatic per-App teardown (deferred — see AD-6). `resetMigrationRegistry()` also clears it for tests.
const registry = new Map<string, MigrationConnectionInfo>();

const coordsOf = (
  options: Options,
  retry: RetryPolicy
): MigrationConnectionInfo => ({
  // Normalize so equivalent spellings of one folder collide (AD-6): `./migrations` === `migrations`
  // === `./migrations/` === an absolute path to the same directory.
  path: resolve(options.migrations?.path ?? MIKRO_ORM_DEFAULT_PATH),
  host: (options as { host?: string }).host,
  dbName: options.dbName,
  tableName: options.migrations?.tableName ?? MIKRO_ORM_DEFAULT_TABLE,
  sharedPhysical: false,
  retry,
});

// A connection's physical-DB identity is only *known* when it configures a concrete, persistent
// `dbName` (with an optional `host`). It is unknown when `dbName` is absent (e.g. a postgres connection
// addressed via `clientUrl`, which MikroORM parses later) or `:memory:`/empty (each in-memory sqlite is
// a distinct database). Two unknown identities are NEVER treated as the same DB — comparing them would
// both reject legitimate multi-connection setups (false positive) and is unprovable. The path guard
// (always known) remains the primary protection; this physical-DB guard fires only when it is certain.
const hasKnownDb = (info: MigrationConnectionInfo): boolean =>
  info.dbName !== undefined && info.dbName !== "" && info.dbName !== ":memory:";

const samePhysicalDb = (
  a: MigrationConnectionInfo,
  b: MigrationConnectionInfo
): boolean =>
  hasKnownDb(a) && hasKnownDb(b) && a.host === b.host && a.dbName === b.dbName;

const dbLabel = (info: MigrationConnectionInfo): string =>
  `dbName "${info.dbName ?? ""}"${info.host ? `, host "${info.host}"` : ""}`;

/**
 * Registers a connection's resolved migration coordinates and **fails closed** on a collision with an
 * already-configured connection (AD-6):
 *
 * - same normalized migrations `path` → throw (their files and snapshot would collide);
 * - same *known* physical DB (`host` + `dbName`) with the same tracking `tableName` → throw (their
 *   histories would overwrite each other);
 * - same known physical DB with **distinct** tables → warn (isolation is by config, not proof of
 *   separate databases) and mark both connections shared-physical, so Story 3.1 refuses `migration:fresh`.
 *
 * Validation runs against existing peers **before** any state is mutated, so a rejected registration
 * leaves the registry untouched. `sharedPhysical` flags are then recomputed across the whole registry,
 * so re-registering a name never leaves a peer's flag stale. `warn` is injectable for testing; it
 * defaults to `console.warn` because `configure()` runs before the DI container (and Spine logger) exists.
 */
export function registerMigrationConnection(
  name: string,
  options: Options,
  retry: RetryPolicy = DEFAULT_RETRY,
  warn: (message: string) => void = (message) => console.warn(message)
): void {
  const info = coordsOf(options, retry);

  // 1. Validate against existing peers WITHOUT mutating — so a throw leaves no partial state behind.
  for (const [otherName, other] of registry) {
    if (otherName === name) continue;

    if (other.path === info.path) {
      throw new Error(
        `@spinejs/mikro-orm: connections "${name}" and "${otherName}" both resolve to the same ` +
          `migrations path "${info.path}". Give each connection its own migrations.path so their ` +
          `migration files and snapshot never collide.`
      );
    }

    if (samePhysicalDb(info, other) && other.tableName === info.tableName) {
      throw new Error(
        `@spinejs/mikro-orm: connections "${name}" and "${otherName}" target the same database ` +
          `(${dbLabel(info)}) with the same migrations tracking table "${
            info.tableName
          }". Give one ` +
          `of them a distinct migrations.tableName so their histories never overwrite each other.`
      );
    }
  }

  // 2. Commit, then recompute shared-physical flags across the whole registry (clearing any stale ones
  //    from a re-registration). Warn only for pairs that involve the just-registered connection.
  registry.set(name, info);
  for (const entry of registry.values()) entry.sharedPhysical = false;
  const entries = [...registry.entries()];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [nameA, a] = entries[i];
      const [nameB, b] = entries[j];
      if (samePhysicalDb(a, b) && a.tableName !== b.tableName) {
        a.sharedPhysical = true;
        b.sharedPhysical = true;
        if (nameA === name || nameB === name) {
          warn(
            `@spinejs/mikro-orm: connections "${nameA}" and "${nameB}" share the same database ` +
              `(${dbLabel(
                a
              )}). Isolation is by config, not proof of separate databases; ` +
              `"migration:fresh" will be refused for them.`
          );
        }
      }
    }
  }
}

/** Whether a connection shares a physical DB with another configured connection (Story 3.1 `fresh` refusal). */
export function isSharedPhysicalConnection(name: string): boolean {
  return registry.get(name)?.sharedPhysical ?? false;
}

/**
 * Whether a connection declared a `migrations` block (so it is a valid migration target). A connection
 * with no migrations is not registered here and cannot be migrated — the CLI/`runMigrations` refuses it
 * with a name-listing error (FR-10, AD-6). Populated at configure time, i.e. when the `AppModule` is
 * imported, so it is ready before `runMigrations` composes anything.
 */
export function isMigrationConnection(name: string): boolean {
  return registry.has(name);
}

/** The names of every connection that configured migrations — for the "unknown connection" error list. */
export function configuredMigrationConnections(): string[] {
  return [...registry.keys()];
}

/**
 * The resolved startup retry policy a configured connection uses — so the migration CLI connects with
 * the **same** policy the app boot would (single config source), not a hardcoded default. `undefined`
 * for a connection that declared no migrations (it is not a migration target).
 */
export function migrationRetryFor(name: string): RetryPolicy | undefined {
  return registry.get(name)?.retry;
}

/** Clears the registry. For test isolation, and for a process that composes more than one App. */
export function resetMigrationRegistry(): void {
  registry.clear();
}
