import { describe, it, expect, beforeEach, afterEach } from "vitest";
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

// Track every temp dir so it is removed even when a test throws before its own cleanup (a leaked-registry
// collision, a failed assertion) — no reliance on OS temp reaping.
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
const tempDir = (): string => {
  const { path, cleanup } = makeTempMigrationsDir();
  cleanups.push(cleanup);
  return path;
};

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
        const path = tempDir();
        const dyn = MikroOrmModule.configure(driver.options(path));
        const value = optionsValueOf(dyn);
        const orm = MikroORM.initSync(value);
        try {
          expect(orm.getMigrator().constructor.name).toBe("Migrator");
          expect((value.migrations as { path: string }).path).toBe(path);
        } finally {
          await orm.close(true).catch(() => undefined);
        }
      });

      // AD-13: fail-closed collision detection is asserted per driver too (config-time, so it runs on
      // both drivers offline). Two connections on the same migrations path must be rejected at configure.
      it("fails closed on a migrations path collision", () => {
        const shared = tempDir();
        MikroOrmModule.configure(driver.options(shared, "harness_c1"));
        expect(() =>
          MikroOrmModule.configure(driver.options(shared, "harness_c2"))
        ).toThrow(/same migrations path/);
      });

      // Live-connection execution belongs to Epic 2 (Story 2.7). Here we only exercise the skip
      // mechanism: sqlite is always live, postgres is skipped unless a connection URL is configured.
      (driver.live ? it : it.skip)(
        "opens a live connection and builds the schema (skipped when the driver is unavailable)",
        async () => {
          const path = tempDir();
          const dyn = MikroOrmModule.configure(driver.options(path));
          const orm = MikroORM.initSync(optionsValueOf(dyn));
          try {
            await orm.connect();
            await orm.schema.refreshDatabase();
            expect(await orm.isConnected()).toBe(true);
          } finally {
            await orm.close(true).catch(() => undefined);
          }
        }
      );
    });
  }
});
