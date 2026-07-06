import type {
  IMigrator,
  ISchemaGenerator,
  UmzugMigration,
} from "@mikro-orm/core";
import { up } from "./run";

/**
 * Pure-function `fresh` handler (AD-5, AD-10): drops the whole schema — **including** the migrations
 * tracking table — then re-applies every migration from scratch. It imports only `@mikro-orm/*` and
 * contains **no policy**: the `NODE_ENV` gate, the `--force-drop` confirmation, and the shared-physical
 * refusal all live in the CLI command layer (AD-8), never here. This handler runs unconditionally once
 * the command layer has cleared it.
 *
 * It takes the schema generator **and** the migrator (both MikroORM primitives) rather than the migrator
 * alone: dropping the schema is a schema-level operation the migrator does not expose. It re-applies to
 * the latest — `fresh` is a full reset, so it carries no `--to`.
 */
export async function fresh(
  schema: Pick<ISchemaGenerator, "dropSchema">,
  migrator: IMigrator
): Promise<UmzugMigration[]> {
  await schema.dropSchema({ dropMigrationsTable: true });
  return up(migrator);
}
