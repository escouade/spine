import type { Options } from "@mikro-orm/core";

// MikroORM's own defaults for a connection that declares neither key — the effective values two
// connections would silently share if nothing namespaced them apart.
const MIKRO_ORM_DEFAULT_PATH = "./migrations";
const MIKRO_ORM_DEFAULT_TABLE = "mikro_orm_migrations";

/** The effective migration coordinates a connection resolves to (used for collision detection). */
interface MigrationConnectionInfo {
  path: string;
  host: string | undefined;
  dbName: string | undefined;
  tableName: string;
  /** Set when another connection shares this one's physical DB (host+dbName) — Story 3.1 refuses `fresh`. */
  sharedPhysical: boolean;
}

// Module-scoped registry of configured migration connections, keyed by connection name. It is populated
// at configure() time — the one place with cross-connection visibility, since each configure() call
// registers a single connection. Global by necessity (mirrors the package's existing per-name node and
// token maps); `resetMigrationRegistry()` clears it for tests.
const registry = new Map<string, MigrationConnectionInfo>();

const coordsOf = (options: Options): MigrationConnectionInfo => ({
  path: options.migrations?.path ?? MIKRO_ORM_DEFAULT_PATH,
  host: (options as { host?: string }).host,
  dbName: options.dbName,
  tableName: options.migrations?.tableName ?? MIKRO_ORM_DEFAULT_TABLE,
  sharedPhysical: false,
});

const samePhysicalDb = (
  a: MigrationConnectionInfo,
  b: MigrationConnectionInfo
): boolean => a.host === b.host && a.dbName === b.dbName;

const dbLabel = (info: MigrationConnectionInfo): string =>
  `dbName "${info.dbName ?? ""}"${info.host ? `, host "${info.host}"` : ""}`;

/**
 * Registers a connection's resolved migration coordinates and **fails closed** on a collision with an
 * already-configured connection (AD-6):
 *
 * - same migrations `path` → throw (their files and snapshot would collide);
 * - same physical DB (`host` + `dbName`) with the same tracking `tableName` → throw (their histories
 *   would overwrite each other);
 * - same physical DB with **distinct** tables → warn (isolation is by config, not proof of separate
 *   databases) and mark both connections shared-physical, so Story 3.1 refuses `migration:fresh` for
 *   them.
 *
 * Re-registering the same name (a memoized node configured again) replaces its entry without
 * self-colliding. `warn` is injectable for testing; it defaults to `console.warn` because `configure()`
 * runs before the DI container (and the Spine logger) exists.
 */
export function registerMigrationConnection(
  name: string,
  options: Options,
  warn: (message: string) => void = (message) => console.warn(message)
): void {
  const info = coordsOf(options);

  for (const [otherName, other] of registry) {
    if (otherName === name) continue;

    if (other.path === info.path) {
      throw new Error(
        `@spinejs/mikro-orm: connections "${name}" and "${otherName}" both resolve to the same ` +
          `migrations path "${info.path}". Give each connection its own migrations.path so their ` +
          `migration files and snapshot never collide.`
      );
    }

    if (samePhysicalDb(info, other)) {
      if (other.tableName === info.tableName) {
        throw new Error(
          `@spinejs/mikro-orm: connections "${name}" and "${otherName}" target the same database ` +
            `(${dbLabel(info)}) with the same migrations tracking table "${
              info.tableName
            }". Give one ` +
            `of them a distinct migrations.tableName so their histories never overwrite each other.`
        );
      }
      warn(
        `@spinejs/mikro-orm: connections "${name}" and "${otherName}" share the same database ` +
          `(${dbLabel(
            info
          )}). Isolation is by config, not proof of separate databases; ` +
          `"migration:fresh" will be refused for them.`
      );
      info.sharedPhysical = true;
      other.sharedPhysical = true;
    }
  }

  registry.set(name, info);
}

/** Whether a connection shares a physical DB with another configured connection (Story 3.1 `fresh` refusal). */
export function isSharedPhysicalConnection(name: string): boolean {
  return registry.get(name)?.sharedPhysical ?? false;
}

/** Clears the registry. For test isolation only. */
export function resetMigrationRegistry(): void {
  registry.clear();
}
