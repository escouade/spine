import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App, Module } from "@spinejs/core";
import type { Logger, ModuleEntry } from "@spinejs/core";
import { MikroORM, type Options } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { Migration } from "@mikro-orm/migrations";
import { ClsModule } from "@spinejs/cls";
import { MikroOrmModule } from "./index";
import { resetMigrationRegistry } from "./mikro-orm.migrations-registry";
import { FIXTURE_ENTITIES } from "./migration-harness";

// Story 3.2 — migrateOnStart: dev-only guarded boot-run. It lives in MikroOrmModule.onStart (the
// start() lifecycle), NOT the headless runMigrations init()-only path (FR-8, NFR-2, AD-8).

type MigrationsList = NonNullable<
  NonNullable<Options["migrations"]>["migrationsList"]
>;

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
const LIST: MigrationsList = [
  { name: "Migration001_users", class: CreateUsers },
];

const makeLogger = () => {
  const warn = vi.fn();
  const info = vi.fn();
  const log = {
    info,
    warn,
    error: vi.fn(),
    debug: vi.fn(),
    verbose: vi.fn(),
    fatal: vi.fn(),
    exit: async () => {},
  } as unknown as Logger;
  return { log, warn, info };
};

let tmp: string;
beforeEach(() => {
  resetMigrationRegistry();
  tmp = mkdtempSync(join(tmpdir(), "spine-mos-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const capture: { orm?: MikroORM } = {};
function makeAppModule(migrateOnStart?: boolean): ModuleEntry {
  capture.orm = undefined;
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
        dbName: join(tmp, "app.sqlite"),
        entities: FIXTURE_ENTITIES,
        migrations: {
          path: join(tmp, "migrations"),
          migrationsList: LIST,
          ...(migrateOnStart !== undefined ? { migrateOnStart } : {}),
        },
      }),
      Probe,
    ],
  })
  class AppModule {}
  return AppModule;
}

// Was the migration applied? (its tracking row exists)
const wasApplied = async (): Promise<boolean> => {
  const executed = await capture.orm!.getMigrator().getExecutedMigrations();
  return executed.length > 0;
};

describe("migrateOnStart", () => {
  it("applies pending migrations at start when enabled and NODE_ENV is development/test", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const app = new App([makeAppModule(true)], {
      logger: makeLogger().log,
      handleProcessExit: false,
    });
    await app.init();
    await app.start();

    expect(await wasApplied()).toBe(true);
    await app.stop();
  });

  it("is a no-op on a second boot when there is no drift (checkMigrationNeeded false)", async () => {
    vi.stubEnv("NODE_ENV", "test");
    // First boot applies it.
    const app1 = new App([makeAppModule(true)], {
      logger: makeLogger().log,
      handleProcessExit: false,
    });
    await app1.init();
    await app1.start();
    await app1.stop();

    // Second boot: schema is current → no-op, and it must not error (a re-apply would throw "exists").
    const app2 = new App([makeAppModule(true)], {
      logger: makeLogger().log,
      handleProcessExit: false,
    });
    await app2.init();
    await app2.start();
    expect(await wasApplied()).toBe(true); // still recorded, not re-applied
    await app2.stop();
  });

  it("does nothing at start when unset (default off), even in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const app = new App([makeAppModule(undefined)], {
      logger: makeLogger().log,
      handleProcessExit: false,
    });
    await app.init();
    await app.start();

    expect(await wasApplied()).toBe(false);
    await app.stop();
  });

  it("refuses (warns + skips) when enabled but NODE_ENV is production — the app still boots", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { log, warn } = makeLogger();
    const app = new App([makeAppModule(true)], {
      logger: log,
      handleProcessExit: false,
    });
    await app.init();
    await app.start(); // boots fine — no throw

    expect(await wasApplied()).toBe(false); // nothing applied
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/migrateOnStart is enabled.*NODE_ENV is not/),
      "MikroOrmModule"
    );
    await app.stop();
  });

  it("runs in onStart, never on the init()-only path (start lifecycle, not init)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const app = new App([makeAppModule(true)], {
      logger: makeLogger().log,
      handleProcessExit: false,
    });

    await app.init(); // onInit only — migrateOnStart lives in onStart, so it has NOT fired yet
    expect(await wasApplied()).toBe(false);

    await app.start(); // onStart runs migrateOnStart
    expect(await wasApplied()).toBe(true);
    await app.stop();
  });
});
