import { InjectionToken } from "@spinejs/core";
import {
  EntityRepository,
  MikroORM,
  type EntityClass,
  type EntityName,
} from "@mikro-orm/core";
import { DEFAULT_CONNECTION } from "./mikro-orm.options";

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

// Stable token per (connection, entity), so `repositoryOf(E, conn)` returns the same token every call —
// a value provider and an `inject:` site therefore resolve the same token. One WeakMap<entity> per
// connection name; the default connection's map yields the SAME tokens as before (back-compat).
const repositoryTokens = new Map<
  string,
  WeakMap<object, InjectionToken<EntityRepository<object>>>
>();

/**
 * Typed injection token for the **default** `EntityRepository<E>` of an entity that needs no custom
 * repository class (ADR 0016 §3). `repositoryOf(User) === repositoryOf(User)` — stable identity — so it
 * both provides and injects the same token. Register the entity with `MikroOrmModule.register([User])`;
 * a provider then injects `[repositoryOf(User)]` and receives a request-scoped `EntityRepository<User>`.
 *
 * `connection` (ADR 0016, Amendment 1) namespaces the token by connection name: identity is
 * `(entity, connection)`, so the same entity on two connections yields two tokens. Omitted (or
 * `"default"`) → the same token as before, bound to the default connection.
 */
export function repositoryOf<E extends object>(
  entity: EntityClass<E>,
  connection: string = DEFAULT_CONNECTION
): InjectionToken<EntityRepository<E>> {
  let byEntity = repositoryTokens.get(connection);
  if (!byEntity) {
    byEntity = new WeakMap();
    repositoryTokens.set(connection, byEntity);
  }
  let token = byEntity.get(entity);
  if (!token) {
    const suffix = connection === DEFAULT_CONNECTION ? "" : `@${connection}`;
    token = new InjectionToken<EntityRepository<object>>(
      `repositoryOf(${entity.name}${suffix})`
    );
    byEntity.set(entity, token);
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
  const matches = Object.values(orm.getMetadata().getAll()).filter(
    (meta) => meta.repository?.() === repo
  );
  if (matches.length === 0) {
    throw new Error(
      `@spinejs/mikro-orm: no entity declares \`repository: () => ${repo.name}\`. ` +
        `Add it to the EntitySchema so MikroOrmModule.register([${repo.name}]) can resolve its entity.`
    );
  }
  if (matches.length > 1) {
    // A custom repository maps to exactly ONE entity; getAll() order is not contractual, so a shared
    // repo would otherwise bind to an arbitrary entity (wrong table, silently). Fail loud instead.
    const names = matches.map((meta) => meta.className).join(", ");
    throw new Error(
      `@spinejs/mikro-orm: ${matches.length} entities (${names}) declare \`repository: () => ${repo.name}\`. ` +
        `A custom repository class must map to exactly one entity — give each entity its own EntityRepository subclass.`
    );
  }
  const [meta] = matches;
  return (meta.class ?? meta.className) as EntityName<object>;
}
