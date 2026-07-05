import { describe, it, expect } from "vitest";
import { MikroORM, EntitySchema, type Options } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { MikroOrmModule } from "./index";
import {
  SPINE_MIGRATION_DEFAULTS,
  resolveMigrationsOptions,
  mikroOrmOptionsToken,
} from "./mikro-orm.options";
import { loadMigratorExtension } from "./mikro-orm.migrator";

// --- Fixture entity (EntitySchema, no decorators — ADR 0016 portable style) ----------------------
class Widget {
  id!: number;
  name!: string;
}
const WidgetSchema = new EntitySchema<Widget>({
  class: Widget,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    name: { type: "string" },
  },
});

const baseOptions = (): Options =>
  ({
    driver: BetterSqliteDriver,
    dbName: ":memory:",
    entities: [WidgetSchema],
  } as Options);

// Pulls the value carried on the `mikroOrmOptionsToken` provider out of a `configure()` result.
const optionsValueOf = (dyn: {
  providers?: unknown[];
}): Record<string, unknown> =>
  (
    (dyn.providers ?? []).find(
      (p) => (p as { provide?: unknown }).provide === mikroOrmOptionsToken
    ) as { value: Record<string, unknown> }
  ).value;

describe("migrations config block + Spine defaults (Story 1.1)", () => {
  describe("resolveMigrationsOptions", () => {
    // NFR-4: no block declared → nothing injected, byte-for-byte as before.
    it("returns undefined unchanged when no migrations block is declared", () => {
      expect(resolveMigrationsOptions(undefined)).toBeUndefined();
    });

    // FR-2: the Spine defaults are applied when keys are omitted.
    it("applies the Spine defaults (emit ts, snapshot/allOrNothing/transactional) for an empty block", () => {
      expect(resolveMigrationsOptions({})).toEqual(SPINE_MIGRATION_DEFAULTS);
      const resolved = resolveMigrationsOptions({})!;
      expect(resolved.emit).toBe("ts");
      expect(resolved.snapshot).toBe(true);
      expect(resolved.allOrNothing).toBe(true);
      expect(resolved.transactional).toBe(true);
    });

    // FR-2: an explicit value always wins over the default for that key.
    it("lets an explicit key override the matching default", () => {
      const resolved = resolveMigrationsOptions({
        snapshot: false,
        allOrNothing: false,
      })!;
      expect(resolved.snapshot).toBe(false);
      expect(resolved.allOrNothing).toBe(false);
      // Untouched keys keep their Spine default.
      expect(resolved.emit).toBe("ts");
      expect(resolved.transactional).toBe(true);
    });

    // FR-1: the declared keys are all carried through.
    it("forwards all supported keys (path, tableName, emit, snapshot, transactional, allOrNothing, disableForeignKeys)", () => {
      const resolved = resolveMigrationsOptions({
        path: "./db/migrations",
        tableName: "my_migrations",
        emit: "js",
        snapshot: false,
        transactional: false,
        allOrNothing: false,
        disableForeignKeys: true,
      })!;
      expect(resolved).toMatchObject({
        path: "./db/migrations",
        tableName: "my_migrations",
        emit: "js",
        snapshot: false,
        transactional: false,
        allOrNothing: false,
        disableForeignKeys: true,
      });
    });

    // NFR-3 / AD-11: the defaults never silently enable the SQLite FK-rebuild footgun.
    it("never auto-enables disableForeignKeys", () => {
      expect("disableForeignKeys" in resolveMigrationsOptions({})!).toBe(false);
    });
  });

  describe("MikroOrmModule.configure() integration", () => {
    // FR-1 + FR-2: a declared block reaches the ORM options with defaults merged in.
    it("carries the migrations block with Spine defaults onto the ORM options", () => {
      const dyn = MikroOrmModule.configure({
        ...baseOptions(),
        migrations: { path: "./migrations" },
      });
      const value = optionsValueOf(dyn);
      expect(value.migrations).toMatchObject({
        path: "./migrations",
        emit: "ts",
        snapshot: true,
        transactional: true,
        allOrNothing: true,
      });
    });

    // NFR-4: no block → no `migrations` key injected (byte-for-byte unchanged).
    it("injects no migrations key when no block is declared", () => {
      const dyn = MikroOrmModule.configure(baseOptions());
      const value = optionsValueOf(dyn);
      expect("migrations" in value).toBe(false);
    });

    // FR-2: explicit override survives the round-trip through configure().
    it("preserves an explicit override through configure()", () => {
      const dyn = MikroOrmModule.configure({
        ...baseOptions(),
        migrations: { snapshot: false },
      });
      const migrations = optionsValueOf(dyn).migrations as Record<
        string,
        unknown
      >;
      expect(migrations.snapshot).toBe(false);
      expect(migrations.transactional).toBe(true);
    });
  });
});

describe("Migrator extension wiring + peer/optional dependency (Story 1.2)", () => {
  // FR-1 / AD-2: a declared block registers the Migrator extension so getMigrator() resolves.
  it("registers the Migrator extension so getMigrator() resolves", async () => {
    const dyn = MikroOrmModule.configure({
      ...baseOptions(),
      migrations: { path: "./migrations" },
    });
    const value = optionsValueOf(dyn) as unknown as Options;
    // The extension is on the resolved options that reach the ORM factory.
    expect(Array.isArray(value.extensions)).toBe(true);

    const orm = MikroORM.initSync(value);
    try {
      const migrator = orm.getMigrator();
      expect(migrator).toBeDefined();
      expect(migrator.constructor.name).toBe("Migrator");
    } finally {
      await orm.close(true).catch(() => undefined);
    }
  });

  // NFR-4 / AD-9: no block → no extension registered, nothing to require.
  it("registers no extension when no migrations block is declared", () => {
    const value = optionsValueOf(MikroOrmModule.configure(baseOptions()));
    expect("extensions" in value).toBe(false);
  });

  // AD-9: a missing peer surfaces an actionable error naming the package and its major.
  it("throws an actionable error when @mikro-orm/migrations is not installed", () => {
    const failingRequire = (() => {
      throw new Error("Cannot find module '@mikro-orm/migrations'");
    }) as unknown as NodeRequire;

    expect(() => loadMigratorExtension(failingRequire)).toThrow(
      /@mikro-orm\/migrations/
    );
    expect(() => loadMigratorExtension(failingRequire)).toThrow(/\^6/);
  });

  // The happy path returns the real Migrator class (default require).
  it("returns the Migrator class when the peer is installed", () => {
    const Migrator = loadMigratorExtension() as { name: string };
    expect(Migrator.name).toBe("Migrator");
  });
});
