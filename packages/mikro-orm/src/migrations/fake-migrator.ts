import { vi } from "vitest";
import type {
  IMigrator,
  MigrationResult,
  MigrationRow,
  UmzugMigration,
} from "@mikro-orm/core";

/**
 * Test-only: a fully-stubbed `IMigrator` for unit-testing the pure-function handlers in isolation
 * (Stories 2.1–2.2), with no database. Every method is a `vi.fn()` so a test can assert exactly what
 * a handler forwarded, and the returns default to the shapes real MikroORM produces (verified against
 * `@mikro-orm/migrations` — e.g. `createMigration` returns an **empty `fileName`** when the schema
 * already matches, which is the "no changes" contract). Pass `overrides` to shape a scenario.
 *
 * Not exported from the package barrel — real end-to-end verb behavior on both drivers is proven by
 * the shared harness (Story 2.7), not by this fake.
 */
export function fakeMigrator(overrides: Partial<IMigrator> = {}): IMigrator {
  const created: MigrationResult = {
    fileName: "Migration20260706000000.ts",
    code: "export class Migration20260706000000 {}",
    diff: { up: ["create table foo"], down: ["drop table foo"] },
  };
  const base: IMigrator = {
    createMigration: vi.fn(async () => created),
    createInitialMigration: vi.fn(async () => created),
    checkMigrationNeeded: vi.fn(async () => true),
    getExecutedMigrations: vi.fn(async (): Promise<MigrationRow[]> => []),
    getPendingMigrations: vi.fn(async (): Promise<UmzugMigration[]> => []),
    up: vi.fn(async (): Promise<UmzugMigration[]> => []),
    down: vi.fn(async (): Promise<UmzugMigration[]> => []),
    on: vi.fn(function (this: IMigrator) {
      return this;
    }),
    off: vi.fn(function (this: IMigrator) {
      return this;
    }),
    // `getStorage` is `@internal` (its return type isn't publicly exported) and no handler calls it;
    // stub it via the interface's own return type so the fake stays fully typed without that import.
    getStorage: vi.fn(() => ({} as ReturnType<IMigrator["getStorage"]>)),
  };
  return { ...base, ...overrides };
}
