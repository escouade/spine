import {
  DynamicModule,
  FactoryProvider,
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
  DEFAULT_RETRY,
  EM,
  mikroOrmOptionsToken,
  retryPolicyToken,
  type MikroOrmModuleOptions,
  type RetryPolicy,
} from "./mikro-orm.options";

/** Log context tag for the module's lifecycle lines. */
const CONTEXT = "MikroOrmModule";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Constructs (does **not** connect) the `MikroORM` instance at module build, wiring spine's CLS as
 * MikroORM's context store (`context: () => cls.get(EM)`, ADR 0016 §1). `initSync` defers the actual
 * connection to `onStart` — the deterministic lifecycle window of ADR 0010.
 */
export const mikroOrmProvider: FactoryProvider<MikroORM> = {
  provide: MikroORM,
  inject: [ClsService, mikroOrmOptionsToken, loggerToken],
  factory: (cls: ClsService, options: Options, log?: Logger): MikroORM => {
    const base: Options = {
      ...options,
      // The load-bearing fact: one AsyncLocalStorage (spine's) backs the request-scoped EntityManager.
      context: () => cls.get(EM) as EntityManager | undefined,
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
  },
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
 * node. It imports `MikroOrmModule` so the one shared `MikroORM` connection resolves the repositories.
 */
@Module({})
class MikroOrmRepositoriesModule {}

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
   * Configures the connection once, at app level:
   * `imports: [MikroOrmModule.configure({ driver, dbName, entities, retry })]`.
   */
  static configure(options: MikroOrmModuleOptions): DynamicModule {
    const { retry, ...ormOptions } = options;
    const resolvedRetry: RetryPolicy = { ...DEFAULT_RETRY, ...retry };

    return {
      module: MikroOrmModule,
      // ClsModule provides the single `ClsService` the factory's `context` hook and the interceptor
      // both read/write — the same singleton the app's `ClsInterceptor` opens scopes on.
      imports: [ClsModule],
      providers: [
        { provide: mikroOrmOptionsToken, value: ormOptions },
        { provide: retryPolicyToken, value: resolvedRetry },
        mikroOrmProvider,
        entityManagerProvider,
        MikroOrmInterceptor,
      ],
      exports: [MikroORM, EntityManager, MikroOrmInterceptor],
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
   * imports `MikroOrmModule`, so there is still one `MikroORM` instance and repos resolve the request
   * fork. A feature module that also needs `EntityManager`/`MikroOrmInterceptor` imports `MikroOrmModule`.
   */
  static register(items: RepositoryRegistration[]): DynamicModule {
    const providers = items.map(
      (item): FactoryProvider<EntityRepository<object>> =>
        isRepositoryClass(item)
          ? {
              provide: item,
              inject: [MikroORM],
              factory: (orm: MikroORM) =>
                orm.em.getRepository(entityForRepository(orm, item)),
            }
          : {
              provide: repositoryOf(item),
              inject: [MikroORM],
              factory: (orm: MikroORM) => orm.em.getRepository(item),
            }
    );

    return {
      module: MikroOrmRepositoriesModule,
      // `fresh` → a distinct node per call: repo tokens do NOT leak to other modules (feature isolation).
      fresh: true,
      // Share the single connection so `MikroORM`/`EntityManager` resolve (one instance, request fork).
      imports: [MikroOrmModule],
      providers,
      exports: providers.map((p) => p.provide),
    };
  }
}
