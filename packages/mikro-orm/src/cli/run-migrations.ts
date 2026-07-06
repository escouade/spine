import { App, InjectionToken, Module, loggerToken } from "@spinejs/core";
import type { DynamicModule, Logger, ModuleEntry, OnInit } from "@spinejs/core";
import { MikroORM } from "@mikro-orm/core";
import {
  DEFAULT_CONNECTION,
  DEFAULT_RETRY,
  mikroOrmRef,
  type RetryPolicy,
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
  isSharedPhysicalConnection,
  migrationRetryFor,
} from "../mikro-orm.migrations-registry";
import { isDevelopmentOrTest } from "../mikro-orm.production-safety";
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
  /** The target connection's resolved retry policy (same as the app boot), for the out-of-band connect. */
  retry: RetryPolicy;
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
    const { orm, log, command, connectionName, flags, retry } = this.spec;
    await connectWithRetry(orm, retry, log);
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
      // whose `onStop` (fired by the outer `app.stop()`) then skips it, so there is no double close. A
      // close failure must never mask the verb's outcome (a `finally` throw would replace it) or flip a
      // successful, already-recorded migration to a failure — swallow it with a log, like the module's
      // own `onStop`.
      try {
        await orm.close(true);
      } catch (err) {
        log.error(
          `@spinejs/mikro-orm: failed to close the "${connectionName}" connection after the migration: ${String(
            err
          )}`
        );
      }
    }
  }

  static for(input: {
    command: MigrationCommand;
    connection: string;
    flags: MigrationFlags;
    retry: RetryPolicy;
  }): DynamicModule {
    const { command, connection, flags, retry } = input;
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
            retry,
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
      // Policy (NODE_ENV / --force-drop / shared-physical) was already enforced pre-compose by
      // `assertFreshAllowed`; the runner just performs the drop + re-run.
      await runner.fresh();
      return;
  }
}

/**
 * The production-safety policy for the destructive `fresh` verb (AD-8, NFR-2). Enforced in the command
 * layer, **before** the app is composed or any connection is opened — so a refusal never touches the
 * database and its diagnostic is never masked by a connect error. Fail-closed and defense-in-depth:
 *
 * 1. `NODE_ENV` must be **explicitly** `development` or `test` (production / unknown / unset all refuse);
 * 2. the orthogonal `--force-drop` flag must be present — a non-prod env label alone never authorizes a
 *    drop;
 * 3. the target connection must **not** share a physical database with another configured **migration**
 *    connection (flagged at configure time, Story 1.3) — a drop cannot be proven to target a distinct DB
 *    (AD-6). Note the guard only sees connections that declare a `migrations` block; a plain connection
 *    on the same database is not tracked, so the operator still owns confirming the DSN's target.
 */
function assertFreshAllowed(
  connectionName: string,
  flags: MigrationFlags
): void {
  if (!isDevelopmentOrTest()) {
    throw new Error(
      `@spinejs/mikro-orm: "migration:fresh" is destructive and refuses to run unless NODE_ENV is ` +
        `explicitly "development" or "test" (it is "${
          process.env.NODE_ENV ?? "unset"
        }"). Set ` +
        `NODE_ENV=development or test, and pass --force-drop.`
    );
  }
  if (!flags.forceDrop) {
    throw new Error(
      `@spinejs/mikro-orm: "migration:fresh" drops the schema — pass --force-drop to confirm ` +
        `(required in addition to a non-production NODE_ENV).`
    );
  }
  if (isSharedPhysicalConnection(connectionName)) {
    throw new Error(
      `@spinejs/mikro-orm: "migration:fresh" refuses connection "${connectionName}" — it shares a ` +
        `physical database with another configured connection, so a drop cannot be proven to target a ` +
        `distinct database. Give the connections distinct databases, or drop it manually.`
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
 *
 * **Precondition (AD-3):** the headless boot runs every module's `onInit`, so it assumes modules do
 * **not** bind external resources (open sockets, listen on ports) in `onInit` — a Spine invariant the
 * feature depends on, not one it can enforce. Transports and the DB connection bind in `onStart`, which
 * this never calls.
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

  // The destructive `fresh` verb's production-safety policy runs here — before composing or opening a
  // connection — so a refusal is fail-closed and never masked by a connect error (AD-8).
  if (command === "fresh") {
    assertFreshAllowed(connectionName, flags);
  }

  const app = new App(
    [
      appModule,
      MigrationCommandModule.for({
        command,
        connection: connectionName,
        flags,
        // The connection's configured retry (recorded at configure time), so the CLI connects with the
        // same policy the app boot would — falling back to the default only if somehow absent.
        retry: migrationRetryFor(connectionName) ?? DEFAULT_RETRY,
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
