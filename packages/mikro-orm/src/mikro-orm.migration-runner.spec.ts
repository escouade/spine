import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Logger } from "@spinejs/core";
import { MikroORM, type IMigrator, type Options } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { MikroOrmModule } from "./index";
import { MigrationRunner } from "./mikro-orm.migration-runner";
import {
  DEFAULT_CONNECTION,
  migrationRunnerRef,
  type MikroOrmModuleOptions,
} from "./mikro-orm.options";
import { resetMigrationRegistry } from "./mikro-orm.migrations-registry";
import { fakeMigrator } from "./migrations/fake-migrator";

// Story 2.4 — the injectable per-connection runner. Unit-tested for delegation + logging against a
// fake ORM/migrator; the wiring is asserted by inspecting the providers `configure()` emits (a live
// end-to-end run on both drivers is Story 2.7).

beforeEach(() => resetMigrationRegistry());

// A logger that captures its `info` lines so per-connection logging (NFR-5) can be asserted.
const makeLogger = () => {
  const info = vi.fn();
  const log = {
    info,
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    fatal: vi.fn(),
  } as unknown as Logger;
  return { log, info };
};

// A fake ORM whose `getMigrator()` returns the given stub — the only method the runner uses.
const ormWith = (
  migrator: IMigrator,
  schema: { dropSchema: (opts?: unknown) => Promise<void> } = {
    dropSchema: vi.fn(async () => {}),
  }
): MikroORM =>
  ({
    getMigrator: () => migrator,
    getSchemaGenerator: () => schema,
  } as unknown as MikroORM);

describe("MigrationRunner (delegation + logging)", () => {
  it("delegates create to the handler and logs the created file, per connection", async () => {
    const migrator = fakeMigrator({
      createMigration: vi.fn(async () => ({
        fileName: "Migration20260706.ts",
        code: "x",
        diff: { up: ["a"], down: ["b"] },
      })),
    });
    const { log, info } = makeLogger();
    const runner = new MigrationRunner(ormWith(migrator), log, "analytics");

    const result = await runner.create({ blank: true });

    expect(result).toMatchObject({
      created: true,
      fileName: "Migration20260706.ts",
    });
    expect(migrator.createMigration).toHaveBeenCalledWith(
      undefined,
      true,
      false
    );
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/connection "analytics".*Migration20260706\.ts/),
      "MigrationRunner"
    );
  });

  it("logs an explicit no-changes line when create finds nothing to do", async () => {
    const migrator = fakeMigrator({
      createMigration: vi.fn(async () => ({
        fileName: "",
        code: "",
        diff: { up: [], down: [] },
      })),
    });
    const { log, info } = makeLogger();
    const runner = new MigrationRunner(ormWith(migrator), log, "default");

    const result = await runner.create();

    expect(result).toEqual({ created: false, reason: "no-changes" });
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/connection "default".*no schema changes/),
      "MigrationRunner"
    );
  });

  it("logs which migrations were applied on up, per connection (NFR-5)", async () => {
    const migrator = fakeMigrator({
      up: vi.fn(async () => [{ name: "M1" }, { name: "M2" }]),
    });
    const { log, info } = makeLogger();
    const runner = new MigrationRunner(ormWith(migrator), log, "analytics");

    const applied = await runner.up();

    expect(applied).toEqual([{ name: "M1" }, { name: "M2" }]);
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(
        /connection "analytics": Applied 2 migration\(s\): M1, M2/
      ),
      "MigrationRunner"
    );
  });

  it("logs a no-op line for up when nothing is pending", async () => {
    const migrator = fakeMigrator({ up: vi.fn(async () => []) });
    const { log, info } = makeLogger();
    const runner = new MigrationRunner(ormWith(migrator), log, "default");

    await runner.up();

    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/no migrations to apply/),
      "MigrationRunner"
    );
  });

  it("logs which migrations were rolled back on down (NFR-5)", async () => {
    const migrator = fakeMigrator({
      down: vi.fn(async () => [{ name: "M2" }]),
    });
    const { log, info } = makeLogger();
    const runner = new MigrationRunner(ormWith(migrator), log, "default");

    const reverted = await runner.down({ to: "M1" });

    expect(reverted).toEqual([{ name: "M2" }]);
    expect(migrator.down).toHaveBeenCalledWith({ to: "M1" });
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(/Rolled back 1 migration\(s\): M2/),
      "MigrationRunner"
    );
  });

  it("drops the schema and re-applies on fresh, logging what was re-applied (NFR-5)", async () => {
    const schema = { dropSchema: vi.fn(async () => {}) };
    const migrator = fakeMigrator({ up: vi.fn(async () => [{ name: "M1" }]) });
    const { log, info } = makeLogger();
    const runner = new MigrationRunner(
      ormWith(migrator, schema),
      log,
      "default"
    );

    const applied = await runner.fresh();

    expect(schema.dropSchema).toHaveBeenCalledWith({
      dropMigrationsTable: true,
    });
    expect(applied).toEqual([{ name: "M1" }]);
    expect(info).toHaveBeenCalledWith(
      expect.stringMatching(
        /dropped the schema and re-applied 1 migration\(s\): M1/
      ),
      "MigrationRunner"
    );
  });

  it("delegates list and pending to the handlers without logging noise", async () => {
    const rows = [{ name: "M1", executed_at: new Date(0) }];
    const pend = [{ name: "M2", path: "/tmp/m2.ts" }];
    const migrator = fakeMigrator({
      getExecutedMigrations: vi.fn(async () => rows),
      getPendingMigrations: vi.fn(async () => pend),
    });
    const { log } = makeLogger();
    const runner = new MigrationRunner(ormWith(migrator), log, "default");

    expect(await runner.list()).toEqual(rows);
    expect(await runner.pending()).toEqual(pend);
  });
});

// --- Wiring: which providers `configure()` emits ------------------------------------------------
const migratingOptions = (
  extra: Partial<MikroOrmModuleOptions> = {}
): MikroOrmModuleOptions =>
  ({
    driver: BetterSqliteDriver,
    dbName: ":memory:",
    entities: [],
    migrations: {},
    ...extra,
  } as MikroOrmModuleOptions);

const providerTokens = (mod: { providers?: { provide: unknown }[] }) =>
  (mod.providers ?? []).map((p) => p.provide);

describe("MigrationRunner wiring", () => {
  it("provides the class token and migrationRunnerRef(default) for the default connection", () => {
    const mod = MikroOrmModule.configure(migratingOptions());
    expect(providerTokens(mod)).toEqual(
      expect.arrayContaining([
        MigrationRunner,
        migrationRunnerRef(DEFAULT_CONNECTION),
      ])
    );
    expect(mod.exports).toEqual(
      expect.arrayContaining([
        MigrationRunner,
        migrationRunnerRef(DEFAULT_CONNECTION),
      ])
    );
  });

  it("resolves migrationRunnerRef(default) through the class token (pass-through)", () => {
    const mod = MikroOrmModule.configure(migratingOptions());
    const passthrough = (mod.providers ?? []).find(
      (p): p is { provide: unknown; inject?: unknown[] } =>
        (p as { provide: unknown }).provide ===
        migrationRunnerRef(DEFAULT_CONNECTION)
    );
    expect(passthrough?.inject).toEqual([MigrationRunner]);
  });

  it("provides and exports migrationRunnerRef(name) for a named connection", () => {
    const mod = MikroOrmModule.configure(
      migratingOptions({ name: "analytics" })
    );
    expect(providerTokens(mod)).toEqual(
      expect.arrayContaining([migrationRunnerRef("analytics")])
    );
    expect(mod.exports).toEqual(
      expect.arrayContaining([migrationRunnerRef("analytics")])
    );
  });

  it("provides NO runner when the connection declares no migrations block (NFR-4)", () => {
    const mod = MikroOrmModule.configure({
      driver: BetterSqliteDriver,
      dbName: ":memory:",
      entities: [],
    } as Options);
    expect(providerTokens(mod)).not.toContain(MigrationRunner);
    expect(providerTokens(mod)).not.toContain(
      migrationRunnerRef(DEFAULT_CONNECTION)
    );
    expect(mod.exports ?? []).not.toContain(MigrationRunner);
  });
});
