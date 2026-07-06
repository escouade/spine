import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EntitySchema, MikroORM, type Options } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { PostgreSqlDriver } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";
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

/**
 * Creates a throwaway migrations directory whose **generated migrations are executable** under the test
 * runner (Story 2.7 verb execution). Two constraints matter, discovered empirically:
 *
 * 1. It lives **inside the project tree** (under `process.cwd()`), not the OS temp dir, so a generated
 *    CommonJS migration's `require("@mikro-orm/migrations")` resolves up to the workspace `node_modules`.
 * 2. It carries a `package.json` marking the folder **CommonJS**, so a `.js` migration is not parsed as
 *    ESM under this package's `type: module` (which would throw `exports is not defined`).
 *
 * Paired with `emit: "js"` (see {@link initVerbOrm}), this lets `up`/`down` load and run real generated
 * migration files under plain Node — no TS loader needed in the test. (Real apps run `.ts` migrations
 * through a TS loader such as `tsx`, or compile them; that runtime concern is documented, not tested.)
 */
export function makeExecutableMigrationsDir(): {
  path: string;
  cleanup: () => void;
} {
  const path = mkdtempSync(join(process.cwd(), "spine-verb-migrations-"));
  writeFileSync(join(path, "package.json"), '{ "type": "commonjs" }\n');
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

/**
 * Builds a **connected** `MikroORM` for a driver with the Migrator extension wired and `emit: "js"` (so
 * generated migrations load under the test runner — see {@link makeExecutableMigrationsDir}). A fresh
 * directory per test means the snapshot stays default-on (so generated migrations get a real `down`).
 * Extra `migrations` options (e.g. `migrationsList`, `allOrNothing`) are merged in for scenario tests.
 * `close(true)` when done.
 */
export async function initVerbOrm(
  driver: HarnessDriver,
  migrationsPath: string,
  migrationsExtra: Options["migrations"] = {}
): Promise<MikroORM> {
  const {
    name: _name,
    retry: _retry,
    multiWrite: _multiWrite,
    ...ormOptions
  } = driver.options(migrationsPath);
  return MikroORM.init({
    ...ormOptions,
    extensions: [Migrator],
    migrations: { ...ormOptions.migrations, emit: "js", ...migrationsExtra },
  });
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
