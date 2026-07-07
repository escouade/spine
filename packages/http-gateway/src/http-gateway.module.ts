import {
  DynamicModule,
  InjectionToken,
  Module,
  ModuleEntry,
  OnStart,
  OnStop,
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
const metaValidatorsToken = new InjectionToken<MetaValidator[]>(
  "http-gateway.meta-validators"
);
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
  inject: [HttpGateway, portToken, metaValidatorsToken] as const,
  providers: [
    { provide: interceptorsToken, value: [] },
    { provide: metaValidatorsToken, value: [] },
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
      ],
      factory: (
        validator: Validator,
        errorMapper: ErrorMapper<string>,
        contextFactory: ContextFactory<HttpRaw, HttpBaseContext>,
        interceptors: ChainInterceptor<HttpBaseContext, string, HttpRoute>[],
        statusMapper: ((code: string) => number) | undefined,
        sseHeartbeatMs: number | undefined
      ) =>
        new HttpGateway(
          validator,
          errorMapper,
          contextFactory,
          interceptors,
          statusMapper,
          sseHeartbeatMs
        ),
    },
  ],
  exports: [HttpGateway],
})
export class HttpGatewayModule implements OnStart, OnStop {
  private server?: ReturnType<HttpGateway["listen"]>;

  constructor(
    private readonly gateway: HttpGateway,
    private readonly port: number | undefined,
    private readonly metaValidators: MetaValidator[]
  ) {}

  /**
   * Once every module is initialized (so all feature modules have registered their routes), crosses
   * this gateway's own routes × its own `metaValidators` — a bad route-inline `meta` slice (e.g. a
   * throttle spec with an unwired `keyBy`) fails boot with the route named. The walk runs BEFORE
   * `listen()`: the port never opens on a misconfigured route. Zero validators wired → no walk.
   */
  onStart(): void {
    validateRouteMeta(
      this.gateway.routes,
      this.metaValidators,
      (a) => `${a.method} ${a.path}` // HttpAddress → the routeId the helpers stamp ("GET /path")
    );
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
    /**
     * Cross-cutting interceptors, outermost-first. An interceptor that also implements
     * `ConnectInterceptor` is automatically enforced at SSE **connect** time (Design 4′) — no separate
     * wiring; a request-only interceptor is never run on a connection. The `interceptors` array keeps
     * its ADR-0017 no-SSE behavior for the streaming body (it never wraps a stream).
     */
    interceptors?: ProviderAdapter<
      ChainInterceptor<HttpBaseContext, string, HttpRoute>[]
    >;
    /**
     * Boot-time, per-route `meta` validators (a separate concept from `interceptors`). At start, this
     * gateway crosses its own routes × these validators and fails boot on a bad route-inline `meta`
     * slice (a battery ships one, e.g. `throttleMetaValidatorRef()`). Default `[]` → no walk.
     */
    metaValidators?: ProviderAdapter<MetaValidator[]>;
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
          metaValidatorsToken,
          options.metaValidators ?? { value: [] }
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
