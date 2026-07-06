import {
  DynamicModule,
  InjectionToken,
  Module,
  ModuleEntry,
  OnStart,
  OnStop,
} from "@spinejs/core";
import { toProvider } from "@spinejs/gateway-core";
import type {
  ContextFactory,
  ErrorMapper,
  ChainInterceptor,
  ProviderAdapter,
  Validator,
} from "@spinejs/gateway-core";
import { HttpGateway } from "./http.gateway";
import type { HttpRoute } from "./http.gateway";
import { ZodValidator } from "./zod.validator";
import { DefaultHttpErrorMapper } from "./default-error.mapper";
import type { HttpBaseContext, HttpRaw } from "./http-base.types";

const validatorToken = new InjectionToken<Validator>("http-gateway.validator");
const errorMapperToken = new InjectionToken<ErrorMapper<string>>(
  "http-gateway.error-mapper"
);
const contextFactoryToken = new InjectionToken<
  ContextFactory<HttpRaw, HttpBaseContext>
>("http-gateway.context-factory");
const interceptorsToken = new InjectionToken<
  ChainInterceptor<HttpBaseContext, string, HttpRoute>[]
>("http-gateway.interceptors");
const connectInterceptorsToken = new InjectionToken<
  ChainInterceptor<HttpBaseContext, string, HttpRoute>[]
>("http-gateway.connect-interceptors");
const statusMapperToken = new InjectionToken<
  ((code: string) => number) | undefined
>("http-gateway.status-mapper");
const portToken = new InjectionToken<number | undefined>("http-gateway.port");
const sseHeartbeatToken = new InjectionToken<number | undefined>(
  "http-gateway.sse-heartbeat"
);

/**
 * Gateway transport module for the HTTP binding (Hono). The base `@Module` registers the
 * `HttpGateway` factory; `configure()` supplies the app's adapter implementations
 * (context factory, error mapper, optional custom validator).
 */
@Module({
  inject: [HttpGateway, portToken] as const,
  providers: [
    { provide: interceptorsToken, value: [] },
    { provide: connectInterceptorsToken, value: [] },
    { provide: statusMapperToken, value: undefined },
    { provide: portToken, value: undefined },
    { provide: sseHeartbeatToken, value: undefined },
    {
      provide: HttpGateway,
      inject: [
        validatorToken,
        errorMapperToken,
        contextFactoryToken,
        interceptorsToken,
        statusMapperToken,
        sseHeartbeatToken,
        connectInterceptorsToken,
      ],
      factory: (
        validator: Validator,
        errorMapper: ErrorMapper<string>,
        contextFactory: ContextFactory<HttpRaw, HttpBaseContext>,
        interceptors: ChainInterceptor<HttpBaseContext, string, HttpRoute>[],
        statusMapper: ((code: string) => number) | undefined,
        sseHeartbeatMs: number | undefined,
        connectInterceptors: ChainInterceptor<
          HttpBaseContext,
          string,
          HttpRoute
        >[]
      ) =>
        new HttpGateway(
          validator,
          errorMapper,
          contextFactory,
          interceptors,
          statusMapper,
          sseHeartbeatMs,
          connectInterceptors
        ),
    },
  ],
  exports: [HttpGateway],
})
export class HttpGatewayModule implements OnStart, OnStop {
  private server?: ReturnType<HttpGateway["listen"]>;

  constructor(
    private readonly gateway: HttpGateway,
    private readonly port: number | undefined
  ) {}

  /** Starts listening once every module is initialized, when `configure()` was given a `port`. */
  onStart(): void {
    if (this.port !== undefined) this.server = this.gateway.listen(this.port);
  }

  /** Closes the listener opened by `onStart()`, if any. */
  onStop(): void {
    this.server?.close();
  }

  /**
   * Supplies the gateway ports (context factory, error mapper, validator) so `HttpGateway` can
   * be instantiated. `imports` should include any module that the context factory's deps live in.
   */
  static configure(options: {
    imports: ModuleEntry[];
    /**
     * A pre-built gateway (or factory for one). When given, it replaces the default `HttpGateway`
     * the module would build from the port adapters below — useful for custom Hono setup or for
     * tests that need to hold the gateway instance and drive `gateway.app.request()` directly.
     * When provided, `contextFactory` is not required (the gateway already has one).
     */
    gateway?: ProviderAdapter<HttpGateway>;
    contextFactory?: ProviderAdapter<ContextFactory<HttpRaw, HttpBaseContext>>;
    errorMapper?: ProviderAdapter<ErrorMapper<string>>;
    validator?: ProviderAdapter<Validator>;
    interceptors?: ProviderAdapter<
      ChainInterceptor<HttpBaseContext, string, HttpRoute>[]
    >;
    /**
     * SSE connection-attempt enforcement (AD-6): interceptors run in `dispatchSse` before guards.
     * Pass the SAME instance you place in `interceptors` (e.g. the throttle interceptor) to close the
     * SSE hole in a global quota with one engine and one store. The main `interceptors` array keeps
     * its ADR-0017 no-SSE behavior. Default: none (SSE unenforced, as before this seam).
     */
    connectInterceptors?: ProviderAdapter<
      ChainInterceptor<HttpBaseContext, string, HttpRoute>[]
    >;
    /** Maps an `ErrorMapper` code to an HTTP status. Defaults to the built-in BAD_REQUEST/UNAUTHORIZED/INTERNAL_ERROR mapping. */
    statusMapper?: ProviderAdapter<(code: string) => number>;
    port?: number;
    /** Interval (ms) between SSE keep-alive comments on a stream; `0` disables. Default 15_000. */
    sseHeartbeatMs?: number;
  }): DynamicModule {
    if (!options.gateway && !options.contextFactory) {
      throw new Error(
        "HttpGatewayModule.configure requires either `gateway` (a pre-built HttpGateway) or `contextFactory` (to build the default one)."
      );
    }
    return {
      module: HttpGatewayModule,
      imports: options.imports,
      providers: [
        toProvider(
          errorMapperToken,
          options.errorMapper ?? { factory: () => new DefaultHttpErrorMapper() }
        ),
        toProvider(
          validatorToken,
          options.validator ?? { factory: () => new ZodValidator() }
        ),
        toProvider(interceptorsToken, options.interceptors ?? { value: [] }),
        toProvider(
          connectInterceptorsToken,
          options.connectInterceptors ?? { value: [] }
        ),
        toProvider(
          statusMapperToken,
          options.statusMapper ?? { value: undefined }
        ),
        toProvider(portToken, { value: options.port }),
        toProvider(sseHeartbeatToken, { value: options.sseHeartbeatMs }),
        // `provide()` upserts by token, so an explicit gateway replaces the base factory below.
        ...(options.contextFactory
          ? [toProvider(contextFactoryToken, options.contextFactory)]
          : []),
        ...(options.gateway ? [toProvider(HttpGateway, options.gateway)] : []),
      ],
    };
  }
}
