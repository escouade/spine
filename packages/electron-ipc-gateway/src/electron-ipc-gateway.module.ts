import {
  DynamicModule,
  InjectionToken,
  Logger,
  loggerToken,
  Module,
  ModuleEntry,
} from "@spinejs/core";
import { toProvider } from "@spinejs/gateway-core";
import type {
  ContextFactory,
  ErrorMapper,
  GatewayInterceptor,
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
  GatewayInterceptor<ElectronIpcBaseContext, string, IpcRoute>[]
>("electron-ipc-gateway.interceptors");

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
  providers: [
    { provide: interceptorsToken, value: [] },
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
        interceptors: GatewayInterceptor<
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
export class ElectronIpcGatewayModule {
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
      GatewayInterceptor<ElectronIpcBaseContext, string, IpcRoute>[]
    >;
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
      ],
    };
  }
}
