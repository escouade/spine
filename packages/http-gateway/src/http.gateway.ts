import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import type { Context as HonoCtx } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import {
  DispatchPipeline,
  LoadedRoute,
  Validator,
  ErrorMapper,
  ChainInterceptor,
  ContextFactory,
  UnauthorizedError,
} from "@spinejs/gateway-core";
import type { HttpAddress, HttpBaseContext, HttpRaw } from "./http-base.types";
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

  constructor(
    private readonly validator: Validator,
    private readonly errorMapper: ErrorMapper<Code>,
    private readonly contextFactory: ContextFactory<HttpRaw, Ctx>,
    interceptors: ChainInterceptor<Ctx, Code, HttpRoute<Ctx>>[] = [],
    private readonly statusMapper: (
      code: Code
    ) => number = defaultStatusMapper as (code: Code) => number,
    /** Interval (ms) between SSE keep-alive comments on a stream; `0` disables. */
    private readonly sseHeartbeatMs = 15_000
  ) {
    this.pipeline = new DispatchPipeline<Ctx, Code, HttpRoute<Ctx>>(
      this.validator,
      this.errorMapper,
      interceptors
    );
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
   */
  get routes(): readonly HttpRoute<Ctx>[] {
    return this._routes;
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
      // Route headers apply only on success and win over the default `Content-Type`.
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (envelope.ok && meta?.headers) Object.assign(headers, meta.headers);
      return new Response(JSON.stringify(envelope), { status, headers });
    });
  }

  /**
   * SSE dispatch: runs guards + input validation up front (a failure returns a normal JSON error
   * envelope, no stream), then streams the handler's `AsyncIterable<SseEvent>` to the client until it
   * disconnects. Bypasses the buffered-`Envelope` pipeline — a stream is many values, not one — while
   * reusing the same guards, validator and error mapping. No interceptor chain and no per-connection
   * CLS scope: the handler gets `ctx` directly, and a long-lived stream must not hold scoped resources
   * (e.g. a DB transaction) open for its whole lifetime.
   */
  private async dispatchSse(
    route: HttpRoute<Ctx>,
    c: HonoCtx
  ): Promise<Response> {
    const ctx = this.contextFactory.create(c);
    try {
      for (const guard of route.guards) {
        if (!(await guard.canActivate(ctx))) throw new UnauthorizedError();
      }
      const rawInput = await extractInput(c, "GET");
      const input = route.input
        ? this.validator.validate(route.input, rawInput)
        : rawInput;
      const result = await route.invoke(ctx, input);
      if (!isAsyncIterable(result)) {
        throw new Error("SSE handler must return an AsyncIterable<SseEvent>");
      }
      const meta = route.meta as HttpRouteMeta | undefined;
      if (meta?.headers) {
        for (const [key, val] of Object.entries(meta.headers))
          c.header(key, val);
      }
      return streamSSE(c, (stream) =>
        pumpSse(stream, result, this.sseHeartbeatMs)
      );
    } catch (err) {
      const code = this.errorMapper.toCode(err);
      return new Response(JSON.stringify({ ok: false, code }), {
        status: this.statusMapper(code),
        headers: { "Content-Type": "application/json" },
      });
    }
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
