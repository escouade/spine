import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import type { Context as HonoCtx, MiddlewareHandler } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import {
  DispatchPipeline,
  LoadedRoute,
  Validator,
  ErrorMapper,
  ChainInterceptor,
  ContextFactory,
  UnauthorizedError,
  assertConnectInterceptorsSafe,
  isConnectInterceptor,
} from "@spinejs/gateway-core";
import type {
  ConnectInterceptor,
  Envelope,
  GatewayInterceptor,
} from "@spinejs/gateway-core";
import {
  readResponseHeadersBag,
  type HttpAddress,
  type HttpBaseContext,
  type HttpRaw,
} from "./http-base.types";
import type { HttpRouteMeta } from "./http-routes";
import type { SseEvent } from "./sse-hub";

/** A route the HTTP transport mounts: the shared dispatch target plus the Hono `{ method, path }`. */
export type HttpRoute<Ctx extends HttpBaseContext = HttpBaseContext> =
  LoadedRoute<Ctx, HttpAddress>;

/**
 * HTTP transport binding using Hono. App-agnostic: it knows only the Hono app and the raw request
 * context — the app context (session, user…) is built by an injected `ContextFactory`, so nothing
 * app-specific leaks in. **Composes** `DispatchPipeline` (guards → validate → invoke → envelope)
 * rather than extending a base; the transport owns address extraction, `register`/`bind` and the
 * envelope→Response mapping.
 *
 * Exposes the Hono `app` for custom mounting (e.g. attaching middleware) and a convenience
 * `listen(port)` for standalone use.
 */
export class HttpGateway<
  Ctx extends HttpBaseContext = HttpBaseContext,
  Code extends string = string
> {
  readonly app = new Hono();
  private readonly pipeline: DispatchPipeline<Ctx, Code, HttpRoute<Ctx>>;
  /** Every route registered so far, accumulated across `register()` calls (one call per feature module). */
  private readonly _routes: HttpRoute<Ctx>[] = [];
  /**
   * The subset of `interceptors` that also implement {@link ConnectInterceptor} — derived once in the
   * constructor. They run in `dispatchSse` at **connection time**, before guards (AD-6). Deriving from
   * the single `interceptors` list (not a second wiring slot) means a connect-capable interceptor is
   * enforced at connect with no extra wiring, while a request-only one (a UoW) is structurally
   * excluded. The intersection type is sound: every element passed the `interceptConnect` filter.
   */
  private readonly connectInterceptors: (GatewayInterceptor<
    Ctx,
    Code,
    HttpRoute<Ctx>
  > &
    ConnectInterceptor<Ctx, Code, HttpRoute<Ctx>>)[];

  constructor(
    private readonly validator: Validator,
    private readonly errorMapper: ErrorMapper<Code>,
    private readonly contextFactory: ContextFactory<HttpRaw, Ctx>,
    interceptors: ChainInterceptor<Ctx, Code, HttpRoute<Ctx>>[] = [],
    private readonly statusMapper: (
      code: Code
    ) => number = defaultStatusMapper as (code: Code) => number,
    /** Interval (ms) between SSE keep-alive comments on a stream; `0` disables. */
    private readonly sseHeartbeatMs = 15_000,
    /**
     * App-level Hono middleware (helmet/compression/CORS…), outermost-first. Mounted here, in the
     * constructor, **before** any route is bound — the gateway is constructed before feature modules'
     * `onInit` call `register()`, and Hono only applies a middleware to routes registered *after* it.
     * Wiring middleware in the constructor makes that ordering deterministic instead of racing route
     * registration in `onStart`.
     */
    middleware: MiddlewareHandler[] = []
  ) {
    // Mount app-level middleware first: the Hono `app` is still empty here (no route bound yet), so
    // every route registered later sits inside these middleware, in array order (outermost-first).
    for (const mw of middleware) this.app.use(mw);
    this.pipeline = new DispatchPipeline<Ctx, Code, HttpRoute<Ctx>>(
      this.validator,
      this.errorMapper,
      interceptors
    );
    // SSE connect safety (ADR 0024): fail boot BEFORE deriving the chain if a `requestScoped`
    // interceptor (a UoW) also declares `interceptConnect`. The capability marker (ADR 0022) proves
    // intent to run at connect, not connect-safety; this closes that residual — including a subclass
    // that inherits `interceptConnect` from a connect-capable base.
    assertConnectInterceptorsSafe(interceptors);
    // SSE connect enforcement (Design 4′): derive the connect chain from the SAME `interceptors` list
    // — every interceptor that implements `ConnectInterceptor` (capability by method presence), in
    // registration order. A request-only interceptor (no `interceptConnect`) is never included, so a
    // request-scoped resource (a UoW transaction) cannot be held open for a stream, by construction.
    this.connectInterceptors = (
      interceptors as GatewayInterceptor<Ctx, Code, HttpRoute<Ctx>>[]
    ).filter(isConnectInterceptor);
  }

  /**
   * Mounts pre-resolved HTTP routes on the Hono app. Called **once per feature module**, so it
   * **accumulates** (appends) — a later module's routes never replace an earlier one's.
   */
  register(routes: HttpRoute<Ctx>[]): void {
    this._routes.push(...routes);
    for (const route of routes) this.bind(route);
  }

  /**
   * Every route registered so far, across all feature modules. The source the OpenAPI battery
   * (`@spinejs/openapi`) reads to build the document — the transport never re-scans controllers.
   * Returns a **snapshot copy**, so a caller can neither mutate the internal registry nor observe
   * routes appended by a later `register()` through a previously read reference.
   */
  get routes(): readonly HttpRoute<Ctx>[] {
    return [...this._routes];
  }

  private bind(route: HttpRoute<Ctx>): void {
    const { method, path } = route.address;
    const meta = route.meta as HttpRouteMeta | undefined;
    if (meta?.sse) {
      this.app.on(method, path, (c: HonoCtx) => this.dispatchSse(route, c));
      return;
    }
    const successStatus = meta?.successStatus;
    this.app.on(method, path, async (c: HonoCtx) => {
      const ctx = this.contextFactory.create(c);
      const rawInput = await extractInput(c, method);
      const envelope = await this.pipeline.dispatch(route, ctx, rawInput);
      const status = envelope.ok
        ? successStatus ?? 200
        : this.statusMapper(envelope.code);
      // Merge order (AD-8): gateway defaults < per-request headers bag < route `meta.headers`.
      // The bag applies on success AND error paths; static route headers stay success-only.
      // A `Headers` object merges case-INSENSITIVELY: a bag `content-type` overrides the default
      // `Content-Type` (a plain-record Object.assign would keep both → a combined header value).
      const headers = new Headers({ "Content-Type": "application/json" });
      const bag = readResponseHeadersBag(ctx);
      if (bag)
        for (const [name, value] of Object.entries(bag))
          headers.set(name, value);
      if (envelope.ok && meta?.headers)
        for (const [name, value] of Object.entries(meta.headers))
          headers.set(name, value);
      return new Response(JSON.stringify(envelope), { status, headers });
    });
  }

  /**
   * SSE dispatch: enforces the connection attempt via `connectInterceptors` (before guards, AD-6),
   * then runs guards + input validation up front (a failure returns a normal JSON error envelope, no
   * stream), then streams the handler's `AsyncIterable<SseEvent>` until the client disconnects.
   * Bypasses the buffered-`Envelope` pipeline — a stream is many values, not one — while reusing the
   * same guards, validator and error mapping. The main `interceptors` chain never runs here (ADR
   * 0017); only `connectInterceptors` do, and only at connect. No per-connection CLS scope: a
   * long-lived stream must not hold scoped resources (e.g. a DB transaction) open for its lifetime.
   */
  private async dispatchSse(
    route: HttpRoute<Ctx>,
    c: HonoCtx
  ): Promise<Response> {
    const ctx = this.contextFactory.create(c);
    // Connection-attempt enforcement (AD-6): run before guards. An allowed connect resolves to a
    // synthetic accept envelope before the stream opens; a deny is written as a JSON failure Response
    // with the header bag merged (draft-6 `RateLimit-*` + `Retry-After` a throttle interceptor wrote).
    // Stream events are never counted — the connect chain runs exactly once, here.
    const rawInput = await extractInput(c, "GET");
    if (this.connectInterceptors.length) {
      const connect = await this.runConnect(route, ctx, rawInput);
      if (!connect.ok) {
        return this.sseJsonResponse(
          ctx,
          connect,
          this.statusMapper(connect.code)
        );
      }
    }
    try {
      for (const guard of route.guards) {
        if (!(await guard.canActivate(ctx))) throw new UnauthorizedError();
      }
      const input = route.input
        ? this.validator.validate(route.input, rawInput)
        : rawInput;
      const result = await route.invoke(ctx, input);
      if (!isAsyncIterable(result)) {
        throw new Error("SSE handler must return an AsyncIterable<SseEvent>");
      }
      const meta = route.meta as HttpRouteMeta | undefined;
      // Stream-open (AD-8): merge the header bag first (a producer's `RateLimit-*` from the accepted
      // connect), then static route headers on top — the same defaults < bag < route order as bind().
      const bag = readResponseHeadersBag(ctx);
      if (bag) for (const [key, val] of Object.entries(bag)) c.header(key, val);
      if (meta?.headers) {
        for (const [key, val] of Object.entries(meta.headers))
          c.header(key, val);
      }
      return streamSSE(c, (stream) =>
        pumpSse(stream, result, this.sseHeartbeatMs)
      );
    } catch (err) {
      const code = this.errorMapper.toCode(err);
      return this.sseJsonResponse(
        ctx,
        { ok: false, code },
        this.statusMapper(code)
      );
    }
  }

  /**
   * Runs the `connectInterceptors` chain around a synthetic accept (`{ ok: true, data: undefined }`)
   * — the SSE connect analogue of `DispatchPipeline.dispatch`. An interceptor short-circuits with a
   * failure envelope (a throttle deny); a throwing interceptor is mapped to a failure code, so the
   * connect path always yields an envelope, never a raw 500.
   */
  private async runConnect(
    route: HttpRoute<Ctx>,
    ctx: Ctx,
    rawInput: unknown
  ): Promise<Envelope<unknown, Code>> {
    const accept = async (): Promise<Envelope<unknown, Code>> => ({
      ok: true,
      data: undefined,
    });
    const chain = this.connectInterceptors.reduceRight(
      (next, interceptor) => () =>
        interceptor.interceptConnect(route, ctx, rawInput, next),
      accept
    );
    try {
      return await chain();
    } catch (err) {
      return { ok: false, code: this.errorMapper.toCode(err) };
    }
  }

  /** Builds a JSON envelope Response on an SSE non-stream path (deny / error), merging the header bag (AD-8). */
  private sseJsonResponse(
    ctx: Ctx,
    envelope: Envelope<unknown, Code>,
    status: number
  ): Response {
    const headers = new Headers({ "Content-Type": "application/json" });
    const bag = readResponseHeadersBag(ctx);
    if (bag)
      for (const [name, value] of Object.entries(bag)) headers.set(name, value);
    return new Response(JSON.stringify(envelope), { status, headers });
  }

  listen(port: number) {
    return serve({ fetch: this.app.fetch, port });
  }
}

/**
 * Extracts the always-structured `{ params, query, body }` input handed to the pipeline, regardless
 * of verb. `body` is the parsed JSON for body-bearing methods (POST/PUT/PATCH), `undefined` else.
 * The composed field-route schema validates this structured object source-by-source.
 */
async function extractInput(c: HonoCtx, method: string): Promise<unknown> {
  const hasBody = ["POST", "PUT", "PATCH"].includes(method);
  const body = hasBody ? await c.req.json().catch(() => undefined) : undefined;
  return {
    params: c.req.param(),
    query: c.req.query(),
    body,
  };
}

/**
 * Pumps an `AsyncIterable<SseEvent>` to a Hono SSE stream until the iterable ends or the client
 * disconnects. Sends a periodic `: ping` comment as a keep-alive. On abort/exit it calls the
 * iterator's `return()` so the source (e.g. an `SseHub`) unsubscribes — no leaked subscription.
 */
async function pumpSse(
  stream: SSEStreamingApi,
  events: AsyncIterable<SseEvent>,
  heartbeatMs: number
): Promise<void> {
  const iterator = events[Symbol.asyncIterator]();
  // The client may already be gone before we register `onAbort` — bail without leaking the subscription.
  if (stream.aborted) {
    await iterator.return?.()?.catch(() => {});
    return;
  }
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          // Fire-and-forget, but swallow the rejection when the stream is already closed.
          void stream.write(": ping\n\n").catch(() => {});
        }, heartbeatMs)
      : undefined;
  heartbeat?.unref?.(); // never let the keep-alive timer keep the process alive on its own
  stream.onAbort(() => void iterator.return?.()?.catch(() => {}));
  try {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done || stream.aborted) break;
      try {
        await stream.writeSSE({
          data: serializeSseData(value.data),
          event: value.event,
          id: value.id,
          retry: value.retry,
        });
      } catch {
        // A single malformed event (unserializable data, a newline in `event`/`id`, an
        // already-closed stream) must not tear the connection down — skip it and keep streaming.
      }
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await iterator.return?.()?.catch(() => {});
  }
}

/** Serialize an event's `data` to a string, never throwing (BigInt / circular / `undefined` → `"null"`). */
function serializeSseData(data: unknown): string {
  if (typeof data === "string") return data;
  try {
    return JSON.stringify(data) ?? "null";
  } catch {
    return "null";
  }
}

/** Structural async-iterable check — an SSE handler must return an `AsyncIterable<SseEvent>`. */
function isAsyncIterable(value: unknown): value is AsyncIterable<SseEvent> {
  return (
    value != null &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

const defaultStatusMap: Record<string, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNPROCESSABLE: 422,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

function defaultStatusMapper(code: string): number {
  return defaultStatusMap[code] ?? 500;
}
