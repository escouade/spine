import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module } from "@spinejs/core";
import type { Logger, ModuleEntry } from "@spinejs/core";
import { MikroORM, type Options } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { Migration } from "@mikro-orm/migrations";
import { ClsModule } from "@spinejs/cls";
import { MikroOrmModule } from "./../index";
import { runMigrations } from "./run-migrations";
import { resetMigrationRegistry } from "./../mikro-orm.migrations-registry";
import { FIXTURE_ENTITIES } from "./../migration-harness";

// Story 2.5 — the headless composition-root. Proven end-to-end on real better-sqlite: `init()`-only,
// the command module connects out-of-band + closes (the reviewer-gate CRITICAL), rejects (never
// exits) on failure, and refuses an unknown connection with a name-listing error. The full
// create→up→down→list round-trip on both drivers is Story 2.7.

// App installs no process handlers here (handleProcessExit: false), so no snapshot/restore is needed.
const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;

// A logger that captures info lines, to assert list/pending CLI output.
const capturingLogger = () => {
  const lines: string[] = [];
  const log = {
    ...silentLogger,
    info: (msg: string) => lines.push(msg),
  } as unknown as Logger;
  return { log, lines };
};

// A pre-seeded in-memory migration (avoids compiling a generated .ts file — that round-trip is 2.7).
class ProbeMigration extends Migration {
  override async up(): Promise<void> {
    this.addSql("create table probe (id integer primary key);");
  }
  override async down(): Promise<void> {
    this.addSql("drop table probe;");
  }
}

let tmp: string;
beforeEach(() => {
  resetMigrationRegistry();
  tmp = mkdtempSync(join(tmpdir(), "spine-mig-e25-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// Build an AppModule around a migrations-configured connection, capturing its `MikroORM` so a test can
// assert lifecycle state after `runMigrations` returns.
type MigrationsList = NonNullable<
  NonNullable<Options["migrations"]>["migrationsList"]
>;

function makeAppModule(opts: {
  name?: string;
  migrationsList?: MigrationsList;
}): { AppModule: ModuleEntry; capture: { orm?: MikroORM } } {
  const capture: { orm?: MikroORM } = {};
  const migrations: Options["migrations"] = {
    path: join(tmp, "migrations"),
    ...(opts.migrationsList ? { migrationsList: opts.migrationsList } : {}),
  };
  const connectionOptions = {
    driver: BetterSqliteDriver,
    dbName: join(tmp, "app.sqlite"),
    entities: FIXTURE_ENTITIES,
    migrations,
    ...(opts.name ? { name: opts.name } : {}),
  };

  @Module({ imports: [MikroOrmModule], inject: [MikroORM] })
  class Probe {
    constructor(orm: MikroORM) {
      capture.orm = orm;
    }
  }

  @Module({
    imports: [
      ClsModule,
      MikroOrmModule.configure(connectionOptions),
      ...(opts.name ? [] : [Probe]),
    ],
  })
  class AppModule {}

  return { AppModule, capture };
}

describe("runMigrations (headless composition-root)", () => {
  it("boots init()-only, connects out-of-band, runs the verb, and closes the connection (AD-3)", async () => {
    const { AppModule, capture } = makeAppModule({});

    // `create` needs a live connection: a naïve init()-only boot (no out-of-band connect) would leave
    // the ORM unconnected and this would throw. It resolving proves the command connected + ran it.
    await runMigrations(AppModule, ["migration:create"], {
      logger: silentLogger,
    });

    const files = readdirSync(join(tmp, "migrations"));
    expect(files.some((f) => /Migration.*\.(ts|js)$/.test(f))).toBe(true);

    // And the connection the command opened was closed afterwards (no leaked connection).
    expect(capture.orm).toBeDefined();
    expect(await capture.orm!.isConnected()).toBe(false);
  });

  it("applies and reports pre-seeded migrations end-to-end, reading one config source (NFR-1)", async () => {
    const list: MigrationsList = [
      { name: "ProbeMigration", class: ProbeMigration },
    ];

    // A fresh App per invocation — exactly the CLI's one-shot boot — all reading the same file DB.
    await runMigrations(
      makeAppModule({ migrationsList: list }).AppModule,
      ["migration:up"],
      {
        logger: silentLogger,
      }
    );

    const listRun = capturingLogger();
    await runMigrations(
      makeAppModule({ migrationsList: list }).AppModule,
      ["migration:list"],
      {
        logger: listRun.log,
      }
    );
    expect(listRun.lines.join("\n")).toMatch(
      /executed migrations: ProbeMigration/
    );

    const pendingRun = capturingLogger();
    await runMigrations(
      makeAppModule({ migrationsList: list }).AppModule,
      ["migration:pending"],
      { logger: pendingRun.log }
    );
    expect(pendingRun.lines.join("\n")).toMatch(/no pending migrations/);
  });

  it("rolls back with down, then reports the migration pending again", async () => {
    const list: MigrationsList = [
      { name: "ProbeMigration", class: ProbeMigration },
    ];
    const boot = () => makeAppModule({ migrationsList: list }).AppModule;

    await runMigrations(boot(), ["migration:up"], { logger: silentLogger });
    await runMigrations(boot(), ["migration:down"], { logger: silentLogger });

    const pendingRun = capturingLogger();
    await runMigrations(boot(), ["migration:pending"], {
      logger: pendingRun.log,
    });
    expect(pendingRun.lines.join("\n")).toMatch(
      /pending migrations: ProbeMigration/
    );
  });

  it("targets a named connection via --connection", async () => {
    const { AppModule } = makeAppModule({ name: "analytics" });

    await runMigrations(
      AppModule,
      ["migration:create", "--connection", "analytics"],
      {
        logger: silentLogger,
      }
    );

    expect(
      readdirSync(join(tmp, "migrations")).some((f) => /Migration/.test(f))
    ).toBe(true);
  });

  it("refuses an unknown connection with an actionable list of configured names (FR-10, AD-6)", async () => {
    const { AppModule } = makeAppModule({});

    await expect(
      runMigrations(AppModule, ["migration:up", "--connection", "ghost"], {
        logger: silentLogger,
      })
    ).rejects.toThrow(
      /connection "ghost" has no migrations configured.*Configured migration connections: default/s
    );
  });

  it("rejects (never process.exit) when the verb fails", async () => {
    const { AppModule } = makeAppModule({});

    // `fresh` parses but is not available until Epic 3 — its handler throws, which must surface as a
    // rejected promise (the process stays alive; only bin.ts maps a rejection to an exit code).
    await expect(
      runMigrations(AppModule, ["migration:fresh"], { logger: silentLogger })
    ).rejects.toThrow(/migration:fresh.*Epic 3/);
  });
});
