import { Module, OnStart } from "@spinejs/core";
import { MikroORM, MikroOrmModule } from "@spinejs/mikro-orm";

/**
 * Creates the schema on boot so the example is runnable against a fresh in-memory database. It injects
 * `MikroORM`, so it initializes AFTER `MikroOrmModule` — its `onStart` therefore runs after the
 * connection is open (spine runs `onStart` hooks deps-before-dependents).
 *
 * A real app manages its schema with migrations, not `createSchema()`; this keeps the demo one file.
 */
@Module({ inject: [MikroORM], imports: [MikroOrmModule] })
export class SchemaModule implements OnStart {
  constructor(private readonly orm: MikroORM) {}

  async onStart(): Promise<void> {
    await this.orm.schema.createSchema();
  }
}
