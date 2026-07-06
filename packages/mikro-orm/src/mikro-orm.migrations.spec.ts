import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MikroORM, EntitySchema, type Options } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { MikroOrmModule } from "./index";
import {
  SPINE_MIGRATION_DEFAULTS,
  resolveMigrationsOptions,
  mikroOrmOptionsToken,
  DEFAULT_RETRY,
} from "./mikro-orm.options";
import { loadMigratorExtension } from "./mikro-orm.migrator";
import {
  registerMigrationConnection,
  isSharedPhysicalConnection,
  resetMigrationRegistry,
} from "./mikro-orm.migrations-registry";

// The collision registry is module-scoped; reset it before each test so configure() calls never leak
// across tests.
beforeEach(() => resetMigrationRegistry());

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

  // A load failure that is NOT "package missing" (version skew, corrupt install) must surface as-is,
  // not be rewritten into a misleading "not installed" message.
  it("rethrows a non-module-not-found load error unchanged", () => {
    const boomRequire = (() => {
      throw new Error("boom: broken internal import");
    }) as unknown as NodeRequire;
    expect(() => loadMigratorExtension(boomRequire)).toThrow(/boom/);
    expect(() => loadMigratorExtension(boomRequire)).not.toThrow(
      /not installed/
    );
  });

  // A transitive module-not-found (a DIFFERENT package missing) must not be misreported as
  // @mikro-orm/migrations being absent.
  it("rethrows a transitive MODULE_NOT_FOUND for a different package", () => {
    const transitiveRequire = (() => {
      const err = new Error("Cannot find module '@mikro-orm/core'") as Error & {
        code: string;
      };
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }) as unknown as NodeRequire;
    expect(() => loadMigratorExtension(transitiveRequire)).toThrow(
      /@mikro-orm\/core/
    );
    expect(() => loadMigratorExtension(transitiveRequire)).not.toThrow(
      /not installed/
    );
  });

  // Resolved but missing the export (mismatched major) → fail loudly, not push undefined.
  it("throws when the package resolves but does not export Migrator", () => {
    const emptyRequire = (() => ({})) as unknown as NodeRequire;
    expect(() => loadMigratorExtension(emptyRequire)).toThrow(
      /did not export `Migrator`/
    );
  });

  // Story 1.2 AC4: the manifest declares the migrations package as an OPTIONAL peer, not a hard dep.
  it("declares @mikro-orm/migrations as an optional peer dependency (^6), not a hard dependency", () => {
    const pkg = JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../package.json", import.meta.url)),
        "utf8"
      )
    ) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    expect(pkg.peerDependencies?.["@mikro-orm/migrations"]).toBe("^6");
    expect(pkg.peerDependenciesMeta?.["@mikro-orm/migrations"]?.optional).toBe(
      true
    );
    expect(pkg.dependencies?.["@mikro-orm/migrations"]).toBeUndefined();
  });
});

describe("per-connection isolation + fail-closed collision guard (Story 1.3)", () => {
  // Builds a bare Options for a physical DB, used to drive the registry directly.
  const opts = (
    dbName: string,
    migrations: NonNullable<Options["migrations"]>,
    host?: string
  ): Options => ({ dbName, host, migrations } as unknown as Options);

  describe("namespaced defaults (AC1)", () => {
    it("defaults a named connection's migrations folder to ./migrations/<name>", () => {
      expect(resolveMigrationsOptions({}, "analytics")?.path).toBe(
        "./migrations/analytics"
      );
    });

    it("leaves the default connection's path unset (MikroORM's ./migrations)", () => {
      expect(resolveMigrationsOptions({})?.path).toBeUndefined();
      expect(resolveMigrationsOptions({}, "default")?.path).toBeUndefined();
    });

    it("lets an explicit path win over the namespaced default", () => {
      expect(
        resolveMigrationsOptions({ path: "./custom" }, "analytics")?.path
      ).toBe("./custom");
    });

    it("strips the Spine-only migrateOnStart before the options reach MikroORM", () => {
      const resolved = resolveMigrationsOptions({
        path: "./m",
        migrateOnStart: true,
      });
      expect(resolved).not.toHaveProperty("migrateOnStart");
      expect(resolved?.path).toBe("./m");
    });
  });

  describe("collision guard (AC2/AC3/AC4)", () => {
    it("fails closed when two connections resolve to the same migrations path", () => {
      registerMigrationConnection("a", opts("db_a", { path: "./shared" }));
      expect(() =>
        registerMigrationConnection("b", opts("db_b", { path: "./shared" }))
      ).toThrow(/both resolve to the same migrations path/);
    });

    it("fails closed when two connections share a physical DB and tracking table", () => {
      // Distinct folders (so no path collision), same host+dbName, same default tableName.
      registerMigrationConnection(
        "a",
        opts("app", { path: "./a" }, "localhost")
      );
      expect(() =>
        registerMigrationConnection(
          "b",
          opts("app", { path: "./b" }, "localhost")
        )
      ).toThrow(/same database.*same migrations tracking table/s);
    });

    it("warns (not throws) when two connections share a physical DB but use distinct tables", () => {
      const warn = vi.fn();
      registerMigrationConnection(
        "a",
        opts("app", { path: "./a", tableName: "m_a" }, "localhost"),
        DEFAULT_RETRY,
        warn
      );
      registerMigrationConnection(
        "b",
        opts("app", { path: "./b", tableName: "m_b" }, "localhost"),
        DEFAULT_RETRY,
        warn
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/share the same database/)
      );
      // Both are flagged so Story 3.1 refuses `fresh` for them.
      expect(isSharedPhysicalConnection("a")).toBe(true);
      expect(isSharedPhysicalConnection("b")).toBe(true);
    });

    it("does not collide a connection with itself when re-registered", () => {
      registerMigrationConnection("a", opts("app", { path: "./a" }));
      expect(() =>
        registerMigrationConnection("a", opts("app", { path: "./a" }))
      ).not.toThrow();
    });
  });

  describe("collision guard through configure() (AC2)", () => {
    it("throws when two named connections are configured on the same path", () => {
      MikroOrmModule.configure({
        driver: BetterSqliteDriver,
        dbName: "db1",
        entities: [WidgetSchema],
        name: "s13x",
        migrations: { path: "./shared-configure" },
      } as Options & { name: string });

      expect(() =>
        MikroOrmModule.configure({
          driver: BetterSqliteDriver,
          dbName: "db2",
          entities: [WidgetSchema],
          name: "s13y",
          migrations: { path: "./shared-configure" },
        } as Options & { name: string })
      ).toThrow(/both resolve to the same migrations path/);
    });
  });
});
