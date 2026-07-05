import { describe, it, expect, vi } from "vitest";
import type { MigrationResult } from "@mikro-orm/core";
import { createMigration } from "./create";
import { fakeMigrator } from "./fake-migrator";

// Story 2.1 — pure-function `create` handler. Tested in isolation against a stubbed `IMigrator`
// (AD-5, AD-10); real end-to-end generation on sqlite + postgres is proven by the harness (Story 2.7).

describe("createMigration", () => {
  it("generates a file from the auto-diff and reports it created (no flags)", async () => {
    const result: MigrationResult = {
      fileName: "Migration20260706120000.ts",
      code: "export class Migration20260706120000 {}",
      diff: { up: ["create table user"], down: ["drop table user"] },
    };
    const migrator = fakeMigrator({
      createMigration: vi.fn(async () => result),
    });

    const outcome = await createMigration(migrator);

    expect(outcome).toEqual({
      created: true,
      fileName: result.fileName,
      code: result.code,
      diff: result.diff,
    });
    // No path passed — the folder comes from the connection's own Migrator config (per-connection
    // isolation, AD-6/AD-10) — and neither variant flag is set for a plain auto-diff.
    expect(migrator.createMigration).toHaveBeenCalledWith(
      undefined,
      false,
      false
    );
  });

  it("reports an explicit 'no changes' and writes no file when the diff is empty", async () => {
    // MikroORM returns an empty fileName (and writes nothing) when the schema already matches.
    const migrator = fakeMigrator({
      createMigration: vi.fn(async () => ({
        fileName: "",
        code: "",
        diff: { up: [], down: [] },
      })),
    });

    const outcome = await createMigration(migrator);

    expect(outcome).toEqual({ created: false, reason: "no-changes" });
  });

  it("forwards --blank to generate an empty hand-written migration", async () => {
    const migrator = fakeMigrator();

    await createMigration(migrator, { blank: true });

    expect(migrator.createMigration).toHaveBeenCalledWith(
      undefined,
      true,
      false
    );
  });

  it("forwards --initial to baseline an existing schema", async () => {
    const migrator = fakeMigrator();

    await createMigration(migrator, { initial: true });

    expect(migrator.createMigration).toHaveBeenCalledWith(
      undefined,
      false,
      true
    );
  });

  it("never applies anything to the database (AD-7): no up/down calls", async () => {
    const migrator = fakeMigrator();

    await createMigration(migrator);

    expect(migrator.up).not.toHaveBeenCalled();
    expect(migrator.down).not.toHaveBeenCalled();
  });
});
