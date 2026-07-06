import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Module } from "@spinejs/core";
import type { Logger, ModuleEntry } from "@spinejs/core";
import { type Options } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { Migration } from "@mikro-orm/migrations";
import { ClsModule } from "@spinejs/cls";
import { MikroOrmModule, runMigrations } from "./index";
import { resetMigrationRegistry } from "./mikro-orm.migrations-registry";
import { FIXTURE_ENTITIES } from "./migration-harness";

// Story 3.3 — multi-connection isolation proven end-to-end (SM-2, FR-10). Two connections, each with
// its own migrations config, migrate independently through `--connection`: separate folders, snapshots,
// and tracking tables — one connection's history never reflects the other's.

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;

const capturingLogger = () => {
  const lines: string[] = [];
  const log = {
    ...silentLogger,
    info: (msg: string) => lines.push(msg),
  } as unknown as Logger;
  return { log, lines };
};

type MigrationsList = NonNullable<
  NonNullable<Options["migrations"]>["migrationsList"]
>;

// One migration per connection, each creating a differently-named table.
class DefaultMigration extends Migration {
  override async up(): Promise<void> {
    this.addSql("create table d_thing (id integer primary key);");
  }
  override async down(): Promise<void> {
    this.addSql("drop table d_thing;");
  }
}
class AnalyticsMigration extends Migration {
  override async up(): Promise<void> {
    this.addSql("create table a_thing (id integer primary key);");
  }
  override async down(): Promise<void> {
    this.addSql("drop table a_thing;");
  }
}
const DEFAULT_LIST: MigrationsList = [
  { name: "Migration001_default", class: DefaultMigration },
];
const ANALYTICS_LIST: MigrationsList = [
  { name: "Migration001_analytics", class: AnalyticsMigration },
];

let tmp: string;
beforeEach(() => {
  resetMigrationRegistry();
  tmp = mkdtempSync(join(tmpdir(), "spine-mcm-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// An AppModule with two connections on SEPARATE databases + folders + migration histories.
function makeAppModule(): ModuleEntry {
  @Module({
    imports: [
      ClsModule,
      MikroOrmModule.configure({
        driver: BetterSqliteDriver,
        dbName: join(tmp, "default.sqlite"),
        entities: FIXTURE_ENTITIES,
        migrations: {
          path: join(tmp, "m-default"),
          migrationsList: DEFAULT_LIST,
        },
      }),
      MikroOrmModule.configure({
        name: "analytics",
        driver: BetterSqliteDriver,
        dbName: join(tmp, "analytics.sqlite"),
        entities: FIXTURE_ENTITIES,
        migrations: {
          path: join(tmp, "m-analytics"),
          migrationsList: ANALYTICS_LIST,
        },
      }),
    ],
  })
  class AppModule {}
  return AppModule;
}

describe("multi-connection migration isolation (SM-2)", () => {
  it("migrates each connection independently; one history never reflects the other", async () => {
    const boot = () => makeAppModule();

    // Apply ONLY the analytics connection.
    await runMigrations(boot(), ["migration:up", "--connection", "analytics"], {
      logger: silentLogger,
    });

    // analytics records its own migration…
    const aList = capturingLogger();
    await runMigrations(
      boot(),
      ["migration:list", "--connection", "analytics"],
      {
        logger: aList.log,
      }
    );
    expect(aList.lines.join("\n")).toMatch(
      /connection "analytics": executed migrations: Migration001_analytics/
    );

    // …while the default connection is untouched — its migration is still pending.
    const dList = capturingLogger();
    await runMigrations(boot(), ["migration:list"], { logger: dList.log });
    expect(dList.lines.join("\n")).toMatch(
      /connection "default": no migrations executed yet/
    );
    const dPending = capturingLogger();
    await runMigrations(boot(), ["migration:pending"], {
      logger: dPending.log,
    });
    expect(dPending.lines.join("\n")).toMatch(
      /connection "default": pending migrations: Migration001_default/
    );

    // Now apply the default connection too.
    await runMigrations(boot(), ["migration:up"], { logger: silentLogger });

    // Each connection's tracking table holds ONLY its own migration — no cross-contamination.
    const dList2 = capturingLogger();
    await runMigrations(boot(), ["migration:list"], { logger: dList2.log });
    expect(dList2.lines.join("\n")).toMatch(
      /connection "default": executed migrations: Migration001_default/
    );
    expect(dList2.lines.join("\n")).not.toMatch(/analytics/);

    const aList2 = capturingLogger();
    await runMigrations(
      boot(),
      ["migration:list", "--connection", "analytics"],
      { logger: aList2.log }
    );
    expect(aList2.lines.join("\n")).toMatch(
      /connection "analytics": executed migrations: Migration001_analytics/
    );
    expect(aList2.lines.join("\n")).not.toMatch(/default/);
  });
});
