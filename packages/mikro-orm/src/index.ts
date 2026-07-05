// @spinejs/mikro-orm public API — MikroORM integration for SpineJS (explicit re-exports, no export *).
// The request-scoped EntityManager / unit-of-work rides spine's CLS: configure the connection once,
// register the interceptor, and services persist at request end with no threaded manager and no .save().
export {
  MikroOrmModule,
  mikroOrmProvider,
  entityManagerProvider,
  connectWithRetry,
} from "./mikro-orm.module";
export { MikroOrmInterceptor } from "./mikro-orm.interceptor";
export { repositoryOf } from "./mikro-orm.repository";
export type {
  RepositoryRegistration,
  EntityRepositoryClass,
} from "./mikro-orm.repository";
export { DEFAULT_RETRY } from "./mikro-orm.options";
export type { MikroOrmModuleOptions, RetryPolicy } from "./mikro-orm.options";

// Re-export the MikroORM primitives a consumer needs (entity/repository/manager), so an app can define
// entities and inject the manager depending on @spinejs/mikro-orm alone. Identity-preserving: these are
// the same classes @mikro-orm/core exports, so the DI tokens match whichever import path is used.
export {
  MikroORM,
  EntityManager,
  EntitySchema,
  EntityRepository,
} from "@mikro-orm/core";
export type { Options } from "@mikro-orm/core";
