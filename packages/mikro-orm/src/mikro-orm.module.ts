import {
  DynamicModule,
  FactoryProvider,
  InjectionToken,
  Logger,
  Module,
  OnStart,
  OnStop,
  loggerToken,
} from "@spinejs/core";
import {
  EntityManager,
  EntityRepository,
  MikroORM,
  type Options,
} from "@mikro-orm/core";
import { ClsModule, ClsService } from "@spinejs/cls";
import { MikroOrmInterceptor } from "./mikro-orm.interceptor";
import { SpineMikroLogger } from "./mikro-orm.logger";
import {
  entityForRepository,
  isRepositoryClass,
  repositoryOf,
  type RepositoryRegistration,
} from "./mikro-orm.repository";
import {
  DEFAULT_CONNECTION,
  DEFAULT_RETRY,
  EM,
  emKey,
  entityManagerRef,
  mikroOrmInterceptorRef,
  mikroOrmOptionsToken,
  mikroOrmRef,
  resolveMigrationsOptions,
  retryPolicyToken,
  type MikroOrmModuleOptions,
  type RetryPolicy,
} from "./mikro-orm.options";

/** Log context tag for the module's lifecycle lines. */
const CONTEXT = "MikroOrmModule";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Builds the `MikroORM` factory for one connection: constructs (does **not** connect) the instance at
 * module build, wiring spine's CLS as MikroORM's context store under THIS connection's key
 * (`context: () => cls.get(emKey(name))`, ADR 0016 §1 / Amendment 1). `initSync` defers the actual
 * connection to `onStart` — the deterministic lifecycle window of ADR 0010.
 *
 * For a **named** connection the `context` hook **throws** when a CLS scope is active but this
 * connection's fork is absent — otherwise MikroORM silently falls back to the root manager and one
 * scope's identity map leaks into the next (Amendment 1, mandatory leak mitigation). On a transport that
 * means its `MikroOrmInterceptor` was not stacked; inside a non-gateway scope (a scheduler tick, a manual
 * `cls.run()`) it means the fork was not seeded. The default connection keeps the plain, non-throwing
 * hook so its behaviour is byte-for-byte unchanged.
 */
const ormFactory =
  (name: string) =>
  (cls: ClsService, options: Options, log?: Logger): MikroORM => {
    const key = emKey(name);
    const guardMissingFork = name !== DEFAULT_CONNECTION;
    const base: Options = {
      ...options,
      // The load-bearing fact: one AsyncLocalStorage (spine's) backs the request-scoped EntityManager.
      context: () => {
        const em = cls.get(key) as EntityManager | undefined;
        if (!em && guardMissingFork && cls.active) {
          throw new Error(
            `@spinejs/mikro-orm: connection "${name}" was used inside an active CLS scope but its ` +
              `request fork is absent — falling back to the root manager would leak one scope's identity ` +
              `map into the next. On a transport, stack its interceptor: add mikroOrmInterceptorRef("${name}") ` +
              `after ClsInterceptor. In a non-gateway scope (e.g. a scheduler tick or a manual cls.run()), ` +
              `seed the fork first with cls.set(emKey("${name}"), orm.em.fork({ disableContextResolution: true })).`
          );
        }
        return em;
      },
    };
    // Bridge MikroORM's logging to the spine logger — one sink, with severity preserved and ANSI
    // stripped (ADR 0016 §5, see SpineMikroLogger). A user-supplied `logger`/`loggerFactory` wins; with
    // no spine logger the bridge is simply not installed (a no-op default), so it never throws.
    if (log && !options.logger && !options.loggerFactory) {
      return MikroORM.initSync({
        ...base,
        loggerFactory: (opts) => new SpineMikroLogger(opts, log),
      });
    }
    return MikroORM.initSync(base);
  };

/**
 * The default connection's `MikroORM` provider (class token). Exported so tests and hand-wiring can call
 * `mikroOrmProvider.factory(cls, options, log)` directly (ADR 0016 §6). Named connections use
 * {@link ormFactory} through `configure({ name })`.
 */
export const mikroOrmProvider: FactoryProvider<MikroORM> = {
  provide: MikroORM,
  inject: [ClsService, mikroOrmOptionsToken, loggerToken],
  factory: ormFactory(DEFAULT_CONNECTION),
};

/**
 * Provides the request-scoped `EntityManager`. The value is `orm.em` — the **root** manager — whose
 * every operation delegates to the current request's fork via `getContext()` (ADR 0016 §2). A service
 * injects `EntityManager` and uses it normally; the fork resolution is transparent.
 */
export const entityManagerProvider: FactoryProvider<EntityManager> = {
  provide: EntityManager,
  inject: [MikroORM],
  factory: (orm: MikroORM): EntityManager => orm.em,
};

/**
 * Connects with retry + backoff. Returns once connected; **throws** after the attempt budget is
 * exhausted, which ADR 0010 turns into a clean, logged boot abort (the app never starts half-up).
 */
export async function connectWithRetry(
  orm: MikroORM,
  retry: RetryPolicy,
  log?: Logger
): Promise<void> {
  // Coerce to a positive integer: a NaN/fractional/≤0 `attempts` must never make the loop skip
  // (`1 <= NaN` is false), which would return WITHOUT connecting and WITHOUT throwing — a "healthy"
  // boot whose first query fails. Guarantees at least one real attempt.
  const attempts = Math.max(1, Math.floor(retry.attempts) || 1);
  // Coerce delay/backoff too (same spirit as `attempts`): a NaN/negative `delayMs` makes `setTimeout`
  // fire ~immediately — retries would hammer with no backoff — and a NaN/<1 `backoff` flattens or
  // inverts the growth. Fall back to the defaults for out-of-range values.
  let wait =
    Number.isFinite(retry.delayMs) && retry.delayMs >= 0
      ? retry.delayMs
      : DEFAULT_RETRY.delayMs;
  const backoff =
    Number.isFinite(retry.backoff) && retry.backoff >= 1
      ? retry.backoff
      : DEFAULT_RETRY.backoff;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      log?.debug(
        `Connecting to the database (attempt ${attempt}/${attempts})`,
        CONTEXT
      );
      await orm.connect();
      log?.info("Database connected", CONTEXT);
      return;
    } catch (err) {
      if (attempt >= attempts) {
        log?.error(
          `Database connection failed after ${attempts} attempt(s)`,
          CONTEXT
        );
        throw err;
      }
      log?.warn(
        `Database connection attempt ${attempt}/${attempts} failed; retrying in ${wait}ms`,
        CONTEXT
      );
      await delay(wait);
      // Cap so a large backoff cannot overflow the timer (Node clamps setTimeout > 2^31-1 to 1ms,
      // which would silently collapse the backoff exactly when the DB needs breathing room).
      wait = Math.min(wait * backoff, 2_147_483_647);
    }
  }
}

/**
 * Internal per-registration feature module. `register()` returns it as a **`fresh`** DynamicModule, so
 * each call is an ISOLATED node (identity = the DynamicModule object, not this class): its repository
 * tokens are exported only to the importing module and do **not** accumulate on the shared connection
 * node. It imports the connection so the shared `MikroORM` resolves the repositories.
 */
@Module({})
class MikroOrmRepositoriesModule {}

/**
 * Per-node bundle carrying what a named connection's lifecycle needs (its own `MikroORM` + retry policy)
 * to the {@link NamedMikroOrmConnection} class. Its identity is fixed (the class's `@Module` inject is
 * static), but each `fresh` named node provides its OWN value into its OWN container (module-loader
 * gives every node a private `Container`), so N named connections never share a spec.
 */
const connectionSpecToken = new InjectionToken<{
  orm: MikroORM;
  retry: RetryPolicy;
}>("mikro-orm.connection-spec");

/**
 * Lifecycle owner for a **named** connection (ADR 0016, Amendment 1). Mirrors {@link MikroOrmModule}'s
 * own lifecycle (connect-with-retry on start, close on stop, never-connected guard) but for the
 * per-connection `MikroORM` it receives via {@link connectionSpecToken}. Reused across all named nodes;
 * `fresh: true` on each node makes the loader build a distinct instance per connection.
 */
@Module({ inject: [connectionSpecToken, loggerToken] })
class NamedMikroOrmConnection implements OnStart, OnStop {
  private connected = false;

  constructor(
    private readonly spec: { orm: MikroORM; retry: RetryPolicy },
    private readonly log: Logger
  ) {}

  async onStart(): Promise<void> {
    await connectWithRetry(this.spec.orm, this.spec.retry, this.log);
    this.connected = true;
  }

  async onStop(): Promise<void> {
    if (!this.connected) return;
    this.log.debug("Closing the database connection", CONTEXT);
    try {
      await this.spec.orm.close(true);
    } catch (err) {
      this.log.error(
        `Failed to close the database connection: ${String(err)}`,
        CONTEXT
      );
    }
  }
}

/**
 * Memoized `fresh` DynamicModule per connection name — the SAME object every call. `configure({ name })`
 * fills it (module, providers, exports); `register(…, { connection })` imports it. Sharing one object
 * makes the two order-independent (whichever runs first creates the shell, the other reuses it) and, per
 * spine's "same DynamicModule imported twice is shared" rule, keeps the connection a single instance
 * even when imported at the app root, on a transport, and by a feature's `register()`.
 */
const connectionNodes = new Map<string, DynamicModule>();
const connectionNode = (name: string): DynamicModule => {
  let node = connectionNodes.get(name);
  if (!node) {
    node = {
      module: NamedMikroOrmConnection,
      fresh: true,
      // Placeholder wiring for the `register({ connection }) before / without configure({ name })` case.
      // `configure({ name })` overwrites `providers` with the real factories; if it NEVER runs, building
      // NamedMikroOrmConnection would otherwise fail on an opaque "Unknown provider mikro-orm.connection-spec"
      // (an internal token the user never wrote). This sentinel turns that into a clear diagnostic.
      providers: [
        {
          provide: connectionSpecToken,
          inject: [],
          factory: (): { orm: MikroORM; retry: RetryPolicy } => {
            throw new Error(
              `@spinejs/mikro-orm: connection "${name}" is registered — register(..., { connection: "${name}" }) ` +
                `— but never configured. Add MikroOrmModule.configure({ name: "${name}", driver, dbName, ... }) ` +
                `at app level.`
            );
          },
        },
      ],
    };
    connectionNodes.set(name, node);
  }
  return node;
};

/**
 * Owns the database connection for a spine app. `MikroOrmModule.configure(options)` registers a single
 * MikroORM connection app-level: the instance is constructed at module build (the factory above),
 * connected on `onStart` (with startup retry), and closed on `onStop` — the atomic, reverse-ordered
 * lifecycle of ADR 0010.
 *
 * ```ts
 * // app.module.ts
 * @Module({
 *   imports: [
 *     MikroOrmModule.configure({
 *       driver: BetterSqliteDriver,
 *       dbName: "app.sqlite",
 *       entities: [UserSchema],
 *       retry: { attempts: 10, delayMs: 500, backoff: 2 },
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 */
@Module({ inject: [MikroORM, loggerToken, retryPolicyToken] })
export class MikroOrmModule implements OnStart, OnStop {
  // Whether onStart actually connected. onStop pairs with onInit (not onStart), so it also runs on a
  // failed boot — when connectWithRetry threw and the ORM was never connected (ADR 0010).
  private connected = false;

  constructor(
    private readonly orm: MikroORM,
    private readonly log: Logger,
    private readonly retry: RetryPolicy
  ) {}

  async onStart(): Promise<void> {
    await connectWithRetry(this.orm, this.retry, this.log);
    this.connected = true;
  }

  async onStop(): Promise<void> {
    // Never-connected (boot abort): nothing to close. Closing anyway could throw out of onStop and
    // MASK the original connection error (App.start drops it if stop() throws) and skip other modules'
    // onStop. Bail out, and even on the connected path never let close() escape.
    if (!this.connected) return;
    this.log.debug("Closing the database connection", CONTEXT);
    try {
      await this.orm.close(true);
    } catch (err) {
      this.log.error(
        `Failed to close the database connection: ${String(err)}`,
        CONTEXT
      );
    }
  }

  /**
   * Configures a connection, at app level:
   * `imports: [MikroOrmModule.configure({ driver, dbName, entities, retry })]`.
   *
   * With **no `name`** this is the default connection — exposed by the `MikroORM` / `EntityManager`
   * **class tokens** and the `MikroOrmInterceptor` class token, exactly as before. Pass a **`name`**
   * (ADR 0016, Amendment 1) to register an additional connection, exposed by `mikroOrmRef(name)` /
   * `entityManagerRef(name)` / `mikroOrmInterceptorRef(name)`, with its own connect/close lifecycle and
   * retry. `multiWrite: true` lets that connection be written in a request that already wrote another —
   * best-effort, no cross-DB atomicity (see {@link MikroOrmInterceptor}). Repeated calls with the same
   * `name` return the same module.
   */
  static configure(options: MikroOrmModuleOptions): DynamicModule {
    const { retry, name, multiWrite = false, ...ormOptions } = options;
    const resolvedRetry: RetryPolicy = { ...DEFAULT_RETRY, ...retry };
    // Apply the Spine migration defaults when (and only when) a `migrations` block is declared —
    // otherwise the options object is passed through untouched, so a connection that never migrates is
    // byte-for-byte as before (NFR-4). Reused by both the named and default connection paths below.
    const resolvedOrmOptions: Options = ormOptions.migrations
      ? {
          ...ormOptions,
          migrations: resolveMigrationsOptions(ormOptions.migrations),
        }
      : ormOptions;

    // Named connection: its own `fresh` node (memoized by name), tokens, lifecycle + retry, interceptor.
    if (name !== undefined && name !== DEFAULT_CONNECTION) {
      const ormRef = mikroOrmRef(name);
      const node = connectionNode(name);
      node.imports = [ClsModule];
      node.providers = [
        {
          provide: ormRef,
          inject: [ClsService, loggerToken],
          factory: (cls: ClsService, log?: Logger) =>
            ormFactory(name)(cls, resolvedOrmOptions, log),
        },
        {
          provide: entityManagerRef(name),
          inject: [ormRef],
          factory: (orm: MikroORM) => orm.em,
        },
        {
          provide: mikroOrmInterceptorRef(name),
          inject: [ormRef, ClsService, loggerToken],
          factory: (orm: MikroORM, cls: ClsService, log: Logger) =>
            new MikroOrmInterceptor(orm, cls, log, emKey(name), multiWrite),
        },
        {
          // Feeds the fresh node's own lifecycle instance (see NamedMikroOrmConnection).
          provide: connectionSpecToken,
          inject: [ormRef],
          factory: (orm: MikroORM) => ({ orm, retry: resolvedRetry }),
        },
      ];
      node.exports = [
        ormRef,
        entityManagerRef(name),
        mikroOrmInterceptorRef(name),
      ];
      return node;
    }

    // Default connection: the unchanged class-token path, plus name-based pass-through providers so
    // `mikroOrmRef("default")` (and the em/interceptor refs) resolve the very same instances — uniform
    // code can address any connection by name, the default included.
    return {
      module: MikroOrmModule,
      // ClsModule provides the single `ClsService` the factory's `context` hook and the interceptor
      // both read/write — the same singleton the app's `ClsInterceptor` opens scopes on.
      imports: [ClsModule],
      providers: [
        { provide: mikroOrmOptionsToken, value: resolvedOrmOptions },
        { provide: retryPolicyToken, value: resolvedRetry },
        mikroOrmProvider,
        entityManagerProvider,
        {
          provide: MikroOrmInterceptor,
          inject: [MikroORM, ClsService, loggerToken],
          factory: (orm: MikroORM, cls: ClsService, log: Logger) =>
            new MikroOrmInterceptor(orm, cls, log, EM, multiWrite),
        },
        {
          provide: mikroOrmRef(DEFAULT_CONNECTION),
          inject: [MikroORM],
          factory: (orm: MikroORM) => orm,
        },
        {
          provide: entityManagerRef(DEFAULT_CONNECTION),
          inject: [EntityManager],
          factory: (em: EntityManager) => em,
        },
        {
          provide: mikroOrmInterceptorRef(DEFAULT_CONNECTION),
          inject: [MikroOrmInterceptor],
          factory: (interceptor: MikroOrmInterceptor) => interceptor,
        },
      ],
      exports: [
        MikroORM,
        EntityManager,
        MikroOrmInterceptor,
        mikroOrmRef(DEFAULT_CONNECTION),
        entityManagerRef(DEFAULT_CONNECTION),
        mikroOrmInterceptorRef(DEFAULT_CONNECTION),
      ],
    };
  }

  /**
   * Exposes a feature module's repositories, each injectable by **class token** (ADR 0016 §3), bound to
   * the request `EntityManager` (each op delegates to the per-request fork via `getContext()`):
   * `imports: [MikroOrmModule.register([UserRepository])]`, then `inject: [UserRepository]`.
   *
   * An entry is either a **custom repository class** (a `EntityRepository<Entity>` subclass — its entity
   * is read back from the `EntitySchema`'s `repository: () => …` link) or an **entity class** (exposes
   * the default `EntityRepository` under `repositoryOf(Entity)`).
   *
   * Each call is **isolated** (a `fresh` node): its repo tokens are visible only to the module that
   * imports this `register(...)`, never to sibling modules. The connection stays shared — the fresh node
   * imports the connection module, so there is still one `MikroORM` instance and repos resolve the
   * request fork. A feature module that also needs `EntityManager`/`MikroOrmInterceptor` imports the
   * connection too.
   *
   * `opts.connection` (ADR 0016, Amendment 1) binds the repositories to a **named** connection — the
   * factories inject `mikroOrmRef(connection)` and `repositoryOf` namespaces the token by connection.
   * Omit it (or pass `"default"`) for the default connection, unchanged.
   *
   * Note: a **custom repository class** is injected by its own class token, which carries no connection —
   * so it binds to a single connection. Registering the same repository class on two connections yields
   * two providers with the same token; to expose one entity on more than one connection use the
   * **entity-class** form, whose `repositoryOf(Entity, connection)` token is namespaced per connection.
   */
  static register(
    items: RepositoryRegistration[],
    opts: { connection?: string } = {}
  ): DynamicModule {
    const connection = opts.connection ?? DEFAULT_CONNECTION;
    const isDefault = connection === DEFAULT_CONNECTION;
    // Default → the `MikroORM` class token + the `MikroOrmModule` class import (as before). Named → that
    // connection's `mikroOrmRef` + its memoized fresh node (the same object `configure({ name })` fills).
    const ormToken = isDefault ? MikroORM : mikroOrmRef(connection);
    const connectionImport: DynamicModule | typeof MikroOrmModule = isDefault
      ? MikroOrmModule
      : connectionNode(connection);

    const providers = items.map(
      (item): FactoryProvider<EntityRepository<object>> =>
        isRepositoryClass(item)
          ? {
              provide: item,
              inject: [ormToken],
              factory: (orm: MikroORM) =>
                orm.em.getRepository(entityForRepository(orm, item)),
            }
          : {
              provide: repositoryOf(item, connection),
              inject: [ormToken],
              factory: (orm: MikroORM) => orm.em.getRepository(item),
            }
    );

    return {
      module: MikroOrmRepositoriesModule,
      // `fresh` → a distinct node per call: repo tokens do NOT leak to other modules (feature isolation).
      fresh: true,
      // Share the connection so `MikroORM`/`EntityManager` resolve (one instance, request fork).
      imports: [connectionImport],
      providers,
      exports: providers.map((p) => p.provide),
    };
  }
}
