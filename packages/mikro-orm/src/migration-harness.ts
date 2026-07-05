import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntitySchema } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import type { MikroOrmModuleOptions } from "./mikro-orm.options";

/**
 * Shared migration test harness (AD-13). Stands up throwaway migration directories and a fixture
 * `EntitySchema` set against **both** sqlite and postgres, so every verb story extends one scaffold
 * rather than inventing its own. This module (Epic 1) provides the environment and config-level
 * assertions; **verb execution** (apply/rollback/tracking-table) is added by Epic 2 (Story 2.7).
 *
 * It is test-only support: it is never re-exported from `index.ts`, so it is not part of the published
 * bundle, and its `@mikro-orm/postgresql` import stays a devDependency.
 */

// --- Fixture entities: a User 1:m Post relation, so the verb stories have a real, multi-table schema to
// diff, apply, and roll back. EntitySchema (no decorators) — the portable style (ADR 0016). ---

export class HarnessUser {
  id!: number;
  email!: string;
}

export class HarnessPost {
  id!: number;
  title!: string;
  author!: HarnessUser;
}

export const HarnessUserSchema = new EntitySchema<HarnessUser>({
  class: HarnessUser,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    email: { type: "string" },
  },
});

export const HarnessPostSchema = new EntitySchema<HarnessPost>({
  class: HarnessPost,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    title: { type: "string" },
    author: { kind: "m:1", entity: () => HarnessUser },
  },
});

/** The fixture entity set every driver builds its schema from. */
export const FIXTURE_ENTITIES = [HarnessUserSchema, HarnessPostSchema];

/** Creates a unique throwaway migrations directory; call `cleanup()` to remove it. */
export function makeTempMigrationsDir(): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), "spine-migrations-"));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

// A live postgres is used only when a connection URL is provided (CI sets it); otherwise the postgres
// driver still stands up offline via `initSync` for config-level checks, but its live-connection cases
// are skipped — keeping sqlite coverage unconditional (AD-13).
const PG_URL = process.env.SPINE_TEST_PG_URL ?? process.env.DATABASE_URL;

export interface HarnessDriver {
  name: string;
  /** Whether this driver can open a **live** connection here (sqlite always; postgres only with a URL). */
  live: boolean;
  /** Builds `MikroOrmModule.configure(...)` options for this driver against a throwaway migrations dir. */
  options(
    migrationsPath: string,
    connectionName?: string
  ): MikroOrmModuleOptions;
}

/** The driver matrix every verb story iterates over (AD-13). */
export const HARNESS_DRIVERS: HarnessDriver[] = [
  {
    name: "sqlite",
    live: true,
    options: (migrationsPath, connectionName) => ({
      driver: BetterSqliteDriver,
      dbName: ":memory:",
      entities: FIXTURE_ENTITIES,
      migrations: { path: migrationsPath },
      ...(connectionName ? { name: connectionName } : {}),
    }),
  },
  {
    name: "postgres",
    live: Boolean(PG_URL),
    options: (migrationsPath, connectionName) => ({
      driver: PostgreSqlDriver,
      clientUrl: PG_URL ?? "postgresql://localhost:5432/spine_migrations_test",
      entities: FIXTURE_ENTITIES,
      migrations: { path: migrationsPath },
      ...(connectionName ? { name: connectionName } : {}),
    }),
  },
];
