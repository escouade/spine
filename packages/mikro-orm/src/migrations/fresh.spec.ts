import { describe, it, expect, vi } from "vitest";
import type { ISchemaGenerator, UmzugMigration } from "@mikro-orm/core";
import { fresh } from "./fresh";
import { fakeMigrator } from "./fake-migrator";

// Story 3.1 — pure `fresh` handler. Drops the whole schema (incl. the tracking table) then re-applies;
// no policy here — that lives in the CLI layer (AD-8, AD-10).

const fakeSchema = (): Pick<ISchemaGenerator, "dropSchema"> => ({
  dropSchema: vi.fn(async () => {}),
});

describe("fresh", () => {
  it("drops the schema including the migrations table, then re-applies migrations", async () => {
    const applied: UmzugMigration[] = [{ name: "M1" }, { name: "M2" }];
    const schema = fakeSchema();
    const migrator = fakeMigrator({ up: vi.fn(async () => applied) });

    const result = await fresh(schema, migrator);

    expect(schema.dropSchema).toHaveBeenCalledWith({
      dropMigrationsTable: true,
    });
    expect(migrator.up).toHaveBeenCalledWith(undefined); // re-applies to latest, no --to
    expect(result).toEqual(applied);
  });

  it("drops before it re-applies (order matters)", async () => {
    const calls: string[] = [];
    const schema = {
      dropSchema: vi.fn(async () => {
        calls.push("drop");
      }),
    };
    const migrator = fakeMigrator({
      up: vi.fn(async () => {
        calls.push("up");
        return [];
      }),
    });

    await fresh(schema, migrator);

    expect(calls).toEqual(["drop", "up"]);
  });
});
