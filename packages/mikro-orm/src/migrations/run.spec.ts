import { describe, it, expect, vi } from "vitest";
import type { MigrationRow, UmzugMigration } from "@mikro-orm/core";
import { up, down, list, pending } from "./run";
import { fakeMigrator } from "./fake-migrator";

// Story 2.2 — pure-function up/down/list/pending handlers. Tested in isolation against a stubbed
// `IMigrator` (AD-5, AD-10); real apply/rollback on sqlite + postgres is proven by the harness (2.7).

describe("up", () => {
  it("applies pending migrations to latest and returns them (no --to)", async () => {
    const applied: UmzugMigration[] = [
      { name: "Migration1" },
      { name: "Migration2" },
    ];
    const migrator = fakeMigrator({ up: vi.fn(async () => applied) });

    const result = await up(migrator);

    expect(result).toEqual(applied);
    expect(migrator.up).toHaveBeenCalledWith(undefined);
  });

  it("migrates up to an explicit version with --to", async () => {
    const migrator = fakeMigrator();

    await up(migrator, { to: "20260705" });

    expect(migrator.up).toHaveBeenCalledWith({ to: "20260705" });
  });

  it("coerces --to 0 to the number 0 (umzug's revert-all sentinel)", async () => {
    const migrator = fakeMigrator();

    await up(migrator, { to: "0" });

    expect(migrator.up).toHaveBeenCalledWith({ to: 0 });
  });

  it("is a no-op when nothing is pending (returns empty)", async () => {
    const migrator = fakeMigrator({ up: vi.fn(async () => []) });

    expect(await up(migrator)).toEqual([]);
  });

  it("propagates a failing batch so the caller can exit non-zero (NFR-3)", async () => {
    const boom = new Error("migration 2 failed; batch rolled back");
    const migrator = fakeMigrator({
      up: vi.fn(async () => {
        throw boom;
      }),
    });

    await expect(up(migrator)).rejects.toBe(boom);
  });
});

describe("down", () => {
  it("rolls back one migration by default and returns it", async () => {
    const reverted: UmzugMigration[] = [{ name: "Migration2" }];
    const migrator = fakeMigrator({ down: vi.fn(async () => reverted) });

    const result = await down(migrator);

    expect(result).toEqual(reverted);
    expect(migrator.down).toHaveBeenCalledWith(undefined);
  });

  it("rolls back to an explicit version with --to", async () => {
    const migrator = fakeMigrator();

    await down(migrator, { to: "20260701" });

    expect(migrator.down).toHaveBeenCalledWith({ to: "20260701" });
  });

  it("coerces down --to 0 to the number 0 (revert everything)", async () => {
    const migrator = fakeMigrator();

    await down(migrator, { to: "0" });

    expect(migrator.down).toHaveBeenCalledWith({ to: 0 });
  });
});

describe("list", () => {
  it("reports executed migrations from the tracking table", async () => {
    const rows: MigrationRow[] = [
      { name: "Migration1", executed_at: new Date(0) },
    ];
    const migrator = fakeMigrator({
      getExecutedMigrations: vi.fn(async () => rows),
    });

    expect(await list(migrator)).toEqual(rows);
  });
});

describe("pending", () => {
  it("reports migrations in the folder not yet executed", async () => {
    const rows: UmzugMigration[] = [{ name: "Migration3", path: "/tmp/m3.ts" }];
    const migrator = fakeMigrator({
      getPendingMigrations: vi.fn(async () => rows),
    });

    expect(await pending(migrator)).toEqual(rows);
  });
});
