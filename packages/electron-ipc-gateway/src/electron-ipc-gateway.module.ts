import {
  DynamicModule,
  InjectionToken,
  Logger,
  loggerToken,
  Module,
  ModuleEntry,
  OnStart,
} from "@spinejs/core";
import { toProvider, validateRouteMeta } from "@spinejs/gateway-core";
import type {
  ContextFactory,
  ErrorMapper,
  ChainInterceptor,
  MetaValidator,
  ProviderAdapter,
  Validator,
} from "@spinejs/gateway-core";
import { ElectronIpcGateway } from "./electron-ipc.gateway";
import type { IpcRoute } from "./electron-ipc.gateway";
import { ZodValidator } from "./zod.validator";
import { DefaultErrorMapper } from "./default-error.mapper";
import type {
  ElectronIpcBaseContext,
  ElectronIpcRaw,
} from "./electron-ipc-base.types";

const validatorToken = new InjectionToken<Validator>(
  "electron-ipc-gateway.validator"
);
const errorMapperToken = new InjectionToken<ErrorMapper<string>>(
  "electron-ipc-gateway.error-mapper"
);
const contextFactoryToken = new InjectionToken<
  ContextFactory<ElectronIpcRaw, ElectronIpcBaseContext>
>("electron-ipc-gateway.context-factory");
const interceptorsToken = new InjectionToken<
  ChainInterceptor<ElectronIpcBaseContext, string, IpcRoute>[]
>("electron-ipc-gateway.interceptors");
const metaValidatorsToken = new InjectionToken<MetaValidator[]>(
  "electron-ipc-gateway.meta-validators"
);

/**
 * Gateway transport module for the Electron IPC binding. The base `@Module` registers the
 * `ElectronIpcGateway` factory (token-injected); `configure()` supplies the app's adapter
 * implementations (context factory, error mapper, optional custom validator).
 *
 * SpineJS merges DynamicModule providers/imports into the singleton class instance, so
 * `configure()` only needs to be called once anywhere in the module graph — all `ipcFeature`
 * usages (which import the bare class) will see the merged providers.
 */
@Module({
  inject: [ElectronIpcGateway, metaValidatorsToken] as const,
  providers: [
    { provide: interceptorsToken, value: [] },
    { provide: metaValidatorsToken, value: [] },
    {
      provide: ElectronIpcGateway,
      inject: [
        validatorToken,
        errorMapperToken,
        contextFactoryToken,
        loggerToken,
        interceptorsToken,
      ],
      factory: (
        validator: Validator,
        errorMapper: ErrorMapper<string>,
        contextFactory: ContextFactory<ElectronIpcRaw, ElectronIpcBaseContext>,
        logger: Logger,
        interceptors: ChainInterceptor<
          ElectronIpcBaseContext,
          string,
          IpcRoute
        >[]
      ) =>
        new ElectronIpcGateway(
          validator,
          errorMapper,
          contextFactory,
          logger,
          interceptors
        ),
    },
  ],
  exports: [ElectronIpcGateway],
})
export class ElectronIpcGatewayModule implements OnStart {
  constructor(
    private readonly gateway: ElectronIpcGateway,
    private readonly metaValidators: MetaValidator[]
  ) {}

  /**
   * Once every module is initialized (so all feature modules have registered their channels), crosses
   * this gateway's own channels × its own `metaValidators` — a bad route-inline `meta` slice (e.g. a
   * throttle spec with `'ip'` on IPC) fails boot with the channel named. IPC has no `listen()`, so the
   * walk is the whole start hook; the channel string IS the routeId. Zero validators wired → no walk.
   */
  onStart(): void {
    validateRouteMeta(
      this.gateway.routes,
      this.metaValidators,
      (channel) => channel // IPC address IS the channel string = routeId
    );
  }

  /**
   * Supplies the three gateway ports (context factory, error mapper, validator) so
   * `ElectronIpcGateway` can be instantiated. `imports` should include any module that
   * the context factory's inject deps live in (e.g. a `SessionModule`).
   */
  static configure(options: {
    imports: ModuleEntry[];
    contextFactory: ProviderAdapter<
      ContextFactory<ElectronIpcRaw, ElectronIpcBaseContext>
    >;
    errorMapper?: ProviderAdapter<ErrorMapper<string>>;
    validator?: ProviderAdapter<Validator>;
    interceptors?: ProviderAdapter<
      ChainInterceptor<ElectronIpcBaseContext, string, IpcRoute>[]
    >;
    /**
     * Boot-time, per-channel `meta` validators (a separate concept from `interceptors`). At start,
     * this gateway crosses its own channels × these validators and fails boot on a bad route-inline
     * `meta` slice (a battery ships one, e.g. `throttleMetaValidatorRef()`). Default `[]` → no walk.
     */
    metaValidators?: ProviderAdapter<MetaValidator[]>;
  }): DynamicModule {
    return {
      module: ElectronIpcGatewayModule,
      imports: options.imports,
      providers: [
        toProvider(contextFactoryToken, options.contextFactory),
        toProvider(
          errorMapperToken,
          options.errorMapper ?? { factory: () => new DefaultErrorMapper() }
        ),
        toProvider(
          validatorToken,
          options.validator ?? { factory: () => new ZodValidator() }
        ),
        toProvider(interceptorsToken, options.interceptors ?? { value: [] }),
        toProvider(
          metaValidatorsToken,
          options.metaValidators ?? { value: [] }
        ),
      ],
    };
  }
}
