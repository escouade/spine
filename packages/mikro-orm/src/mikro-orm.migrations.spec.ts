import { describe, it, expect } from "vitest";
import { EntitySchema, type Options } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { MikroOrmModule } from "./index";
import {
  SPINE_MIGRATION_DEFAULTS,
  resolveMigrationsOptions,
  mikroOrmOptionsToken,
} from "./mikro-orm.options";

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
