import { InjectionToken } from "@spinejs/core";
import {
  EntityRepository,
  MikroORM,
  type EntityClass,
  type EntityName,
} from "@mikro-orm/core";

/**
 * A custom repository class — a subclass of MikroORM's `EntityRepository`, the home for custom queries
 * (ADR 0016 §3). Injected by its own class token via typed `inject:` arrays.
 */
// `any` mirrors MikroORM's own repository typing; the concrete entity is recovered per registration.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type EntityRepositoryClass = new (
  ...args: any[]
) => EntityRepository<any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * An entry accepted by `MikroOrmModule.register([...])`: either a **custom repository class** (injected
 * by its class token) or an **entity class** (exposes the default `EntityRepository` under
 * `repositoryOf(Entity)`).
 */
export type RepositoryRegistration =
  | EntityRepositoryClass
  | EntityClass<object>;

// Stable token per entity class, so `repositoryOf(E)` returns the same token every call — a value
// provider and an `inject:` site therefore resolve the same token.
const repositoryTokens = new WeakMap<
  object,
  InjectionToken<EntityRepository<object>>
>();

/**
 * Typed injection token for the **default** `EntityRepository<E>` of an entity that needs no custom
 * repository class (ADR 0016 §3). `repositoryOf(User) === repositoryOf(User)` — stable identity — so it
 * both provides and injects the same token. Register the entity with `MikroOrmModule.register([User])`;
 * a provider then injects `[repositoryOf(User)]` and receives a request-scoped `EntityRepository<User>`.
 */
export function repositoryOf<E extends object>(
  entity: EntityClass<E>
): InjectionToken<EntityRepository<E>> {
  let token = repositoryTokens.get(entity);
  if (!token) {
    token = new InjectionToken<EntityRepository<object>>(
      `repositoryOf(${entity.name})`
    );
    repositoryTokens.set(entity, token);
  }
  return token as InjectionToken<EntityRepository<E>>;
}

/** True for a custom repository class (a subclass of `EntityRepository`). */
export function isRepositoryClass(
  x: RepositoryRegistration
): x is EntityRepositoryClass {
  return typeof x === "function" && x.prototype instanceof EntityRepository;
}

/**
 * Reverse-maps a custom repository class to its entity via ORM metadata. The entity's `EntitySchema`
 * must declare `repository: () => TheRepository` (the MikroORM-native link); this reads that back so
 * the user only writes `register([TheRepository])`. Throws a clear error if no entity declares it.
 */
export function entityForRepository(
  orm: MikroORM,
  repo: EntityRepositoryClass
): EntityName<object> {
  for (const meta of Object.values(orm.getMetadata().getAll())) {
    if (meta.repository?.() === repo) {
      return (meta.class ?? meta.className) as EntityName<object>;
    }
  }
  throw new Error(
    `@spinejs/mikro-orm: no entity declares \`repository: () => ${repo.name}\`. ` +
      `Add it to the EntitySchema so MikroOrmModule.register([${repo.name}]) can resolve its entity.`
  );
}
