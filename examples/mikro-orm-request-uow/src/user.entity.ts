import { EntitySchema, EntityRepository } from "@spinejs/mikro-orm";

/**
 * The domain entity. A plain class — no decorators. The `EntitySchema` below describes its columns
 * (the portable style under spine's stage-3 / no-`reflect-metadata` build).
 */
export class User {
  id!: number;
  email!: string;
  name!: string;
}

/**
 * A custom repository: the home for entity-specific queries. It is injected later by its own class
 * token (`inject: [UserRepository]`); every operation runs against the current request's forked
 * `EntityManager`, resolved transparently through CLS.
 */
export class UserRepository extends EntityRepository<User> {
  findByEmail(email: string): Promise<User | null> {
    return this.findOne({ email });
  }
}

/**
 * Wires the class to its table. `repository: () => UserRepository` is REQUIRED so
 * `MikroOrmModule.register([UserRepository])` can recover the entity from the repository class.
 */
export const UserSchema = new EntitySchema<User>({
  class: User,
  repository: () => UserRepository,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    email: { type: "string", unique: true },
    name: { type: "string" },
  },
});
