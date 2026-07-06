import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { App, Module } from "@spinejs/core";
import type { Logger } from "@spinejs/core";
import { MikroORM } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { Migration } from "@mikro-orm/migrations";
import { ClsModule } from "@spinejs/cls";
import { MikroOrmModule, runMigrations } from "./index";
import { createMigration } from "./migrations/create";
import { up, down, list, pending } from "./migrations/run";
import { fresh } from "./migrations/fresh";
import { resetMigrationRegistry } from "./mikro-orm.migrations-registry";
import {
  HARNESS_DRIVERS,
  FIXTURE_ENTITIES,
  makeExecutableMigrationsDir,
  initVerbOrm,
} from "./migration-harness";

// Story 2.7 — verb execution, extending the Epic 1 harness across sqlite + postgres (AD-13). Proves
// SM-1 (edited entity → applied, tracked migration), transactional integrity (NFR-3), and that the
// runtime and the CLI read one config source (NFR-1). Postgres runs only when a URL is configured;
// sqlite is unconditional.

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;

beforeEach(() => resetMigrationRegistry());

describe.each(HARNESS_DRIVERS)("migration verbs on $name", (driver) => {
  const test = driver.live ? it : it.skip;
  let orm: MikroORM | undefined;
  let dir: { path: string; cleanup: () => void } | undefined;

  afterEach(async () => {
    if (orm) await orm.close(true).catch(() => {});
    orm = undefined;
    dir?.cleanup();
    dir = undefined;
  });

  test("create → up tracks an edited entity end-to-end (SM-1, FR-3/5/6)", async () => {
    dir = makeExecutableMigrationsDir();
    orm = await initVerbOrm(driver, dir.path);
    const migrator = orm.getMigrator();

    // create: the auto-diff captures both fixture tables; nothing is applied yet (AD-7).
    const created = await createMigration(migrator);
    expect(created.created).toBe(true);
    if (!created.created) throw new Error("unreachable");
    const diff = created.diff.up.join("\n").toLowerCase();
    expect(diff).toMatch(/create table.*harness_user/s);
    expect(diff).toContain("harness_post");
    expect(await list(migrator)).toHaveLength(0); // create applied nothing

    // up: applies the one pending migration; the tracking table records it; pending is then empty.
    const applied = await up(migrator);
    expect(applied).toHaveLength(1);
    expect(await list(migrator)).toHaveLength(1);
    expect(await pending(migrator)).toHaveLength(0);

    // A second up with nothing pending is a no-op.
    expect(await up(migrator)).toHaveLength(0);

    // And re-running create now finds no schema drift → no file, explicit "no changes" (FR-3).
    const again = await createMigration(migrator);
    expect(again).toEqual({ created: false, reason: "no-changes" });
  });

  test("down rolls back an applied migration, running its down() and clearing the tracking row (FR-5)", async () => {
    dir = makeExecutableMigrationsDir();

    class WithDown extends Migration {
      override async up(): Promise<void> {
        this.addSql("create table probe_down (id integer primary key);");
      }
      override async down(): Promise<void> {
        this.addSql("drop table probe_down;");
      }
    }

    orm = await initVerbOrm(driver, dir.path, {
      migrationsList: [{ name: "Migration001_withdown", class: WithDown }],
    });
    const migrator = orm.getMigrator();

    await up(migrator);
    expect(await list(migrator)).toHaveLength(1);
    // The up() ran — the table exists.
    await orm.em.getConnection().execute("select * from probe_down");

    const reverted = await down(migrator);
    expect(reverted).toHaveLength(1);
    expect(await list(migrator)).toHaveLength(0);
    expect(await pending(migrator)).toHaveLength(1);
    // The down() ran — the table is gone.
    await expect(
      orm.em.getConnection().execute("select * from probe_down")
    ).rejects.toThrow();
  });

  test("allOrNothing rolls the whole batch back on failure, leaving the DB unchanged (NFR-3)", async () => {
    dir = makeExecutableMigrationsDir();

    class Good extends Migration {
      override async up(): Promise<void> {
        this.addSql("create table probe_a (id integer primary key);");
      }
      override async down(): Promise<void> {
        this.addSql("drop table probe_a;");
      }
    }
    class Bad extends Migration {
      override async up(): Promise<void> {
        this.addSql("this is not valid sql;");
      }
      override async down(): Promise<void> {}
    }

    orm = await initVerbOrm(driver, dir.path, {
      migrationsList: [
        { name: "Migration001_good", class: Good },
        { name: "Migration002_bad", class: Bad },
      ],
      allOrNothing: true,
      transactional: true,
    });
    const migrator = orm.getMigrator();

    await expect(up(migrator)).rejects.toThrow();
    // The good migration's table must not survive — the batch rolled back atomically…
    await expect(
      orm.em.getConnection().execute("select * from probe_a")
    ).rejects.toThrow();
    // …and nothing was recorded as executed.
    expect(await list(migrator)).toHaveLength(0);
  });

  test("fresh drops the schema (incl. data) and re-applies from scratch (FR-9)", async () => {
    dir = makeExecutableMigrationsDir();

    // A migration creating a table that IS in the fixture entity metadata (harness_user), so the
    // entity-metadata-driven dropSchema drops it. Portable SQL (no autoincrement) for both drivers.
    class CreateUsers extends Migration {
      override async up(): Promise<void> {
        this.addSql(
          "create table harness_user (id integer not null primary key, email text not null);"
        );
      }
      override async down(): Promise<void> {
        this.addSql("drop table harness_user;");
      }
    }
    orm = await initVerbOrm(driver, dir.path, {
      migrationsList: [{ name: "Migration001_users", class: CreateUsers }],
    });
    const migrator = orm.getMigrator();

    await up(migrator);
    await orm.em
      .getConnection()
      .execute("insert into harness_user (id, email) values (1, 'a@b.c')");
    expect(
      await orm.em.getConnection().execute("select * from harness_user")
    ).toHaveLength(1);

    const applied = await fresh(orm.getSchemaGenerator(), migrator);

    // The table exists again (re-applied) but is empty — the data was dropped, proving a real reset.
    expect(applied).toHaveLength(1);
    expect(
      await orm.em.getConnection().execute("select * from harness_user")
    ).toHaveLength(0);
    expect(await list(migrator)).toHaveLength(1); // tracking re-recorded
  });

  test("two connections keep independent tracking tables (SM-2, AD-6)", async () => {
    const dirA = makeExecutableMigrationsDir();
    const dirB = makeExecutableMigrationsDir();
    class MigA extends Migration {
      override async up(): Promise<void> {
        this.addSql("create table iso_a (id integer primary key);");
      }
      override async down(): Promise<void> {
        this.addSql("drop table iso_a;");
      }
    }
    class MigB extends Migration {
      override async up(): Promise<void> {
        this.addSql("create table iso_b (id integer primary key);");
      }
      override async down(): Promise<void> {
        this.addSql("drop table iso_b;");
      }
    }
    // Distinct folders AND distinct tracking tables — so even on one shared postgres database (the
    // harness's single clientUrl), each connection's history is isolated by config (AD-6).
    const ormA = await initVerbOrm(driver, dirA.path, {
      tableName: "m_iso_a",
      migrationsList: [{ name: "MigA", class: MigA }],
    });
    const ormB = await initVerbOrm(driver, dirB.path, {
      tableName: "m_iso_b",
      migrationsList: [{ name: "MigB", class: MigB }],
    });
    try {
      await up(ormA.getMigrator());
      await up(ormB.getMigrator());

      // Each tracking table holds ONLY its own migration — never the other connection's.
      expect((await list(ormA.getMigrator())).map((r) => r.name)).toEqual([
        "MigA",
      ]);
      expect((await list(ormB.getMigrator())).map((r) => r.name)).toEqual([
        "MigB",
      ]);
      expect(await pending(ormA.getMigrator())).toHaveLength(0);
      expect(await pending(ormB.getMigrator())).toHaveLength(0);
    } finally {
      await ormA.close(true).catch(() => {});
      await ormB.close(true).catch(() => {});
      dirA.cleanup();
      dirB.cleanup();
    }
  });
});

// NFR-1 — the runtime and the CLI resolve the SAME connection config from one AppModule, no second
// artifact to drift. sqlite runs unconditionally.
describe("one config source: runtime boot vs runMigrations (NFR-1)", () => {
  const snapshot = (orm: MikroORM) => {
    const m = orm.config.get("migrations");
    return {
      driver: (orm.config.get("driver") as { name: string }).name,
      dbName: orm.config.get("dbName"),
      entities: (orm.config.get("entities") as unknown[]).length,
      // The whole resolved migration settings block — driver, db, entities AND migration settings must
      // match across both boot paths (the AC's full list), not just the folder.
      migrations: {
        path: m.path,
        tableName: m.tableName,
        emit: m.emit,
        snapshot: m.snapshot,
        transactional: m.transactional,
        allOrNothing: m.allOrNothing,
      },
    };
  };

  it("both boot paths derive identical driver/db/migrations config", async () => {
    const dir = makeExecutableMigrationsDir();
    const dbFile = join(dir.path, "nfr1.sqlite");
    const capture: { orm?: MikroORM } = {};

    @Module({ imports: [MikroOrmModule], inject: [MikroORM] })
    class Probe {
      constructor(orm: MikroORM) {
        capture.orm = orm;
      }
    }

    @Module({
      imports: [
        ClsModule,
        MikroOrmModule.configure({
          driver: BetterSqliteDriver,
          dbName: dbFile,
          entities: FIXTURE_ENTITIES,
          migrations: { path: dir.path },
        }),
        Probe,
      ],
    })
    class AppModule {}

    // Runtime boot (onStart connects).
    const app = new App([AppModule], {
      logger: silentLogger,
      handleProcessExit: false,
    });
    await app.init();
    await app.start();
    const runtime = snapshot(capture.orm!);
    await app.stop();

    // CLI boot — a fresh App from the SAME AppModule via the headless composition-root.
    capture.orm = undefined;
    await runMigrations(AppModule, ["migration:pending"], {
      logger: silentLogger,
    });
    const cli = snapshot(capture.orm!);

    expect(cli).toEqual(runtime);
    dir.cleanup();
  });
});
