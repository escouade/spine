import { App, InjectionToken, Module, loggerToken } from "@spinejs/core";
import type { DynamicModule, Logger, ModuleEntry, OnInit } from "@spinejs/core";
import { MikroORM } from "@mikro-orm/core";
import {
  DEFAULT_CONNECTION,
  DEFAULT_RETRY,
  mikroOrmRef,
} from "../mikro-orm.options";
import {
  MikroOrmModule,
  connectWithRetry,
  connectionNode,
} from "../mikro-orm.module";
import { MigrationRunner } from "../mikro-orm.migration-runner";
import {
  configuredMigrationConnections,
  isMigrationConnection,
} from "../mikro-orm.migrations-registry";
import {
  parseArgv,
  type MigrationCommand,
  type MigrationFlags,
} from "./parse-argv";

/** Log context tag for the command layer's list/pending report lines. */
const CONTEXT = "MigrationRunner";

/** Everything the command module's `onInit` needs — the target ORM + logger, resolved by DI, plus the verb. */
interface MigrationCommandSpec {
  orm: MikroORM;
  log: Logger;
  command: MigrationCommand;
  connectionName: string;
  flags: MigrationFlags;
}

const migrationCommandSpecToken = new InjectionToken<MigrationCommandSpec>(
  "mikro-orm.migration-command-spec"
);

/**
 * The headless command module composed alongside the user's `AppModule` (AD-3). It runs the verb in
 * `onInit` and — because the composition-root calls `app.init()` **only**, so `MikroOrmModule.onStart`
 * (which connects) never fires — it **drives the target connection's lifecycle out-of-band**:
 * `connectWithRetry` → verb → `orm.close(true)` in a `finally`. Without that, the `init()`-only boot
 * would leave the ORM unconnected and never closed (the reviewer-gate CRITICAL — do not remove).
 *
 * The connection reaches this module through a **factory provider** whose `inject` names a **concrete**
 * token — `MikroORM` for the default connection, `mikroOrmRef(name)` for a named one — known from argv
 * before compose, so there is no `App.get`/`resolve` (AD-4). It imports the connection module so its
 * `onInit` is dependency-ordered **after** the connection's, and so the token is in its own container
 * (cross-module tokens are not visible to siblings): the default's class-identity node, or the named
 * connection's memoized `connectionNode`.
 */
@Module({ inject: [migrationCommandSpecToken] })
export class MigrationCommandModule implements OnInit {
  constructor(private readonly spec: MigrationCommandSpec) {}

  async onInit(): Promise<void> {
    const { orm, log, command, connectionName, flags } = this.spec;
    await connectWithRetry(orm, DEFAULT_RETRY, log);
    try {
      await runVerb(
        new MigrationRunner(orm, log, connectionName),
        command,
        flags,
        log,
        connectionName
      );
    } finally {
      // Close the connection this module opened, decoupled from `MikroOrmModule`'s `connected` flag —
      // whose `onStop` (fired by the outer `app.stop()`) then skips it, so there is no double close.
      await orm.close(true);
    }
  }

  static for(input: {
    command: MigrationCommand;
    connection: string;
    flags: MigrationFlags;
  }): DynamicModule {
    const { command, connection, flags } = input;
    const isDefault = connection === DEFAULT_CONNECTION;
    const ormToken = isDefault ? MikroORM : mikroOrmRef(connection);
    // Import the connection so its token lands in THIS module's container (siblings can't see each
    // other's exports): the default connection is reached by the `MikroOrmModule` class node the
    // AppModule's `configure()` populated; a named one by its memoized `connectionNode` (same object).
    const connectionImport: ModuleEntry = isDefault
      ? MikroOrmModule
      : connectionNode(connection);
    return {
      module: MigrationCommandModule,
      // A distinct node per command run — never shared or memoized.
      fresh: true,
      imports: [connectionImport],
      providers: [
        {
          provide: migrationCommandSpecToken,
          inject: [ormToken, loggerToken],
          factory: (orm: MikroORM, log: Logger): MigrationCommandSpec => ({
            orm,
            log,
            command,
            connectionName: connection,
            flags,
          }),
        },
      ],
    };
  }
}

/** Dispatch a parsed verb to the runner; `list`/`pending` are reported through the logger for the CLI. */
async function runVerb(
  runner: MigrationRunner,
  command: MigrationCommand,
  flags: MigrationFlags,
  log: Logger,
  connectionName: string
): Promise<void> {
  switch (command) {
    case "create":
      await runner.create(flags);
      return;
    case "up":
      await runner.up(flags);
      return;
    case "down":
      await runner.down(flags);
      return;
    case "list": {
      const rows = await runner.list();
      log.info(
        rows.length
          ? `connection "${connectionName}": executed migrations: ${rows
              .map((r) => r.name)
              .join(", ")}`
          : `connection "${connectionName}": no migrations executed yet`,
        CONTEXT
      );
      return;
    }
    case "pending": {
      const rows = await runner.pending();
      log.info(
        rows.length
          ? `connection "${connectionName}": pending migrations: ${rows
              .map((m) => m.name)
              .join(", ")}`
          : `connection "${connectionName}": no pending migrations`,
        CONTEXT
      );
      return;
    }
    case "fresh":
      // Parsed here since Story 2.3, but the guarded `fresh` command lands in Epic 3.
      throw new Error(
        `@spinejs/mikro-orm: "migration:fresh" is not available yet — it ships in the safe-automation epic (Epic 3).`
      );
  }
}

/**
 * Run a migration verb against the app's real module graph, headless (FR-4, FR-7, AD-3). Parses `argv`,
 * composes `new App([AppModule, MigrationCommandModule.for(...)])`, and calls **`app.init()` only** — no
 * transport binds a port. The command module connects the target connection, runs the verb, and closes
 * it; `app.stop()` (outer `finally`) tears the rest of the graph down.
 *
 * Resolves on success and **rejects on failure — it never calls `process.exit`** (only `bin.ts` maps the
 * outcome to an exit code, AD-5), so a programmatic caller is never killed. An unknown `--connection`
 * fails fast with an actionable list of the configured migration connections, before anything is
 * composed (FR-10, AD-6).
 */
export async function runMigrations(
  appModule: ModuleEntry,
  argv: string[],
  options: { logger?: Logger } = {}
): Promise<void> {
  const { command, connection, flags } = parseArgv(argv);
  const connectionName = connection ?? DEFAULT_CONNECTION;

  // Fail before composing if the target is not a configured migration connection — an actionable list,
  // not an opaque "unknown provider" from DI (the registry is populated at AppModule import time).
  if (!isMigrationConnection(connectionName)) {
    const configured = configuredMigrationConnections();
    throw new Error(
      `@spinejs/mikro-orm: connection "${connectionName}" has no migrations configured. ` +
        (configured.length > 0
          ? `Configured migration connections: ${configured.join(", ")}.`
          : `No connection declares a migrations block — add one to MikroOrmModule.configure({ ..., migrations: {} }).`)
    );
  }

  const app = new App(
    [
      appModule,
      MigrationCommandModule.for({
        command,
        connection: connectionName,
        flags,
      }),
    ],
    {
      handleProcessExit: false,
      ...(options.logger ? { logger: options.logger } : {}),
    }
  );
  try {
    await app.init();
  } finally {
    await app.stop();
  }
}
