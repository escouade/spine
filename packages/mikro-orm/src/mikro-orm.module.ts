import {
  DynamicModule,
  FactoryProvider,
  Logger,
  Module,
  OnStart,
  OnStop,
  loggerToken,
} from "@spinejs/core";
import { EntityManager, MikroORM, type Options } from "@mikro-orm/core";
import { ClsModule, ClsService } from "@spinejs/cls";
import { MikroOrmInterceptor } from "./mikro-orm.interceptor";
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
  inject: [ClsService, mikroOrmOptionsToken],
  factory: (cls: ClsService, options: Options): MikroORM =>
    MikroORM.initSync({
      ...options,
      // The load-bearing fact: one AsyncLocalStorage (spine's) backs the request-scoped EntityManager.
      context: () => cls.get(EM) as EntityManager | undefined,
    }),
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
  const attempts = Math.max(1, retry.attempts);
  let wait = retry.delayMs;

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
      wait *= retry.backoff;
    }
  }
}

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
  constructor(
    private readonly orm: MikroORM,
    private readonly log: Logger,
    private readonly retry: RetryPolicy
  ) {}

  onStart(): Promise<void> {
    return connectWithRetry(this.orm, this.retry, this.log);
  }

  async onStop(): Promise<void> {
    this.log.debug("Closing the database connection", CONTEXT);
    await this.orm.close(true);
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
}
