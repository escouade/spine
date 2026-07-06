import type { Logger } from "@spinejs/core";
import type { MikroORM, MigrationRow, UmzugMigration } from "@mikro-orm/core";
import {
  createMigration,
  up,
  down,
  list,
  pending,
  type CreateMigrationFlags,
  type CreateMigrationResult,
  type VersionFlags,
} from "./migrations";

/** Log context tag for a runner's per-connection migration lines. */
const CONTEXT = "MigrationRunner";

/**
 * Runs migration operations against **one** connection, programmatically (FR-7). Injected per
 * connection — `migrationRunnerRef(name)`, the default under the `MigrationRunner` class token — it
 * wraps that connection's `MikroORM` and delegates every verb to the **same** pure-function handlers
 * the CLI uses (AD-5), so the programmatic and CLI paths never diverge. It is the layer that logs
 * which migrations were applied/rolled back, per connection, through Spine's logger (NFR-5) — the
 * leaf handlers stay silent and pure (AD-10).
 *
 * It does **not** own the connection lifecycle: the ORM must already be connected (the module's
 * `onStart` in a running app, or the headless command-module out-of-band in the CLI — AD-3). The
 * runner only uses `orm.getMigrator()`, which requires the Migrator extension — wired by `configure`
 * whenever a `migrations` block is present (Story 1.2), so a runner is provided only for such a
 * connection.
 */
export class MigrationRunner {
  constructor(
    private readonly orm: MikroORM,
    private readonly log: Logger,
    /** The connection this runner targets — tags every log line so multi-connection runs are legible. */
    private readonly connectionName: string
  ) {}

  /** Generate a migration from the auto-diff (or `--blank`/`--initial`); writes files, never the DB. */
  async create(
    flags: CreateMigrationFlags = {}
  ): Promise<CreateMigrationResult> {
    const result = await createMigration(this.orm.getMigrator(), flags);
    if (result.created) {
      this.log.info(
        `${this.tag()} created migration ${result.fileName}`,
        CONTEXT
      );
    } else {
      this.log.info(
        `${this.tag()} no schema changes; no migration created`,
        CONTEXT
      );
    }
    return result;
  }

  /** Apply pending migrations (to latest, or `--to`); logs what was applied (NFR-5). */
  async up(flags: VersionFlags = {}): Promise<UmzugMigration[]> {
    const applied = await up(this.orm.getMigrator(), flags);
    this.report("Applied", "apply", applied);
    return applied;
  }

  /** Roll back the most recent migration (or down to `--to`); logs what was rolled back (NFR-5). */
  async down(flags: VersionFlags = {}): Promise<UmzugMigration[]> {
    const reverted = await down(this.orm.getMigrator(), flags);
    this.report("Rolled back", "roll back", reverted);
    return reverted;
  }

  /** Executed migrations from this connection's tracking table (FR-6). */
  async list(): Promise<MigrationRow[]> {
    return list(this.orm.getMigrator());
  }

  /** Migrations present in the folder but not yet executed on this connection (FR-6). */
  async pending(): Promise<UmzugMigration[]> {
    return pending(this.orm.getMigrator());
  }

  private tag(): string {
    return `connection "${this.connectionName}":`;
  }

  private report(
    pastLabel: string,
    infinitive: string,
    migrations: UmzugMigration[]
  ): void {
    if (migrations.length === 0) {
      this.log.info(`${this.tag()} no migrations to ${infinitive}`, CONTEXT);
      return;
    }
    const names = migrations.map((m) => m.name).join(", ");
    this.log.info(
      `${this.tag()} ${pastLabel} ${migrations.length} migration(s): ${names}`,
      CONTEXT
    );
  }
}
