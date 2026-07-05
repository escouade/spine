import { describe, it, expect, beforeEach } from "vitest";
import { existsSync } from "node:fs";
import { MikroORM, type Options } from "@mikro-orm/core";
import { MikroOrmModule } from "./index";
import {
  mikroOrmOptionsToken,
  resolveMigrationsOptions,
} from "./mikro-orm.options";
import { resetMigrationRegistry } from "./mikro-orm.migrations-registry";
import {
  HARNESS_DRIVERS,
  FIXTURE_ENTITIES,
  makeTempMigrationsDir,
} from "./migration-harness";

beforeEach(() => resetMigrationRegistry());

const optionsValueOf = (dyn: { providers?: unknown[] }): Options =>
  (
    (dyn.providers ?? []).find(
      (p) => (p as { provide?: unknown }).provide === mikroOrmOptionsToken
    ) as { value: Options }
  ).value;

describe("shared migration test harness (Story 1.4)", () => {
  it("exposes a fixture EntitySchema set of at least two entities", () => {
    expect(FIXTURE_ENTITIES.length).toBeGreaterThanOrEqual(2);
  });

  it("creates and cleans up a throwaway migrations directory", () => {
    const { path, cleanup } = makeTempMigrationsDir();
    expect(existsSync(path)).toBe(true);
    cleanup();
    expect(existsSync(path)).toBe(false);
  });

  it("namespaces a named connection's migrations folder (driver-agnostic)", () => {
    expect(resolveMigrationsOptions({}, "analytics")?.path).toBe(
      "./migrations/analytics"
    );
  });

  for (const driver of HARNESS_DRIVERS) {
    describe(`driver: ${driver.name}`, () => {
      // Config-level checks run on BOTH drivers offline — initSync constructs without connecting, and
      // getMigrator() resolves from the registered extension without a live database.
      it("stands up a migrations environment and resolves the Migrator", async () => {
        const { path, cleanup } = makeTempMigrationsDir();
        const dyn = MikroOrmModule.configure(driver.options(path));
        const value = optionsValueOf(dyn);
        const orm = MikroORM.initSync(value);
        try {
          expect(orm.getMigrator().constructor.name).toBe("Migrator");
          expect((value.migrations as { path: string }).path).toBe(path);
        } finally {
          await orm.close(true).catch(() => undefined);
          cleanup();
        }
      });

      // Live-connection execution belongs to Epic 2 (Story 2.7). Here we only exercise the skip
      // mechanism: sqlite is always live, postgres is skipped unless a connection URL is configured.
      (driver.live ? it : it.skip)(
        "opens a live connection and builds the schema (skipped when the driver is unavailable)",
        async () => {
          const { path, cleanup } = makeTempMigrationsDir();
          const dyn = MikroOrmModule.configure(driver.options(path));
          const orm = MikroORM.initSync(optionsValueOf(dyn));
          try {
            await orm.connect();
            await orm.schema.refreshDatabase();
            expect(await orm.isConnected()).toBe(true);
          } finally {
            await orm.close(true).catch(() => undefined);
            cleanup();
          }
        }
      );
    });
  }
});
