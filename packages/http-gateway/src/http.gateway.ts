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
  GatewayInterceptor,
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

  constructor(
    private readonly validator: Validator,
    private readonly errorMapper: ErrorMapper<Code>,
    private readonly contextFactory: ContextFactory<HttpRaw, Ctx>,
    interceptors: GatewayInterceptor<Ctx, Code, HttpRoute<Ctx>>[] = [],
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

  /** Mounts pre-resolved HTTP routes on the Hono app. Called by the feature module. */
  register(routes: HttpRoute<Ctx>[]): void {
    for (const route of routes) this.bind(route);
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
      const events = (await route.invoke(
        ctx,
        input
      )) as AsyncIterable<SseEvent>;
      return streamSSE(c, (stream) =>
        pumpSse(stream, events, this.sseHeartbeatMs)
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
  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => void stream.write(": ping\n\n"), heartbeatMs)
      : undefined;
  heartbeat?.unref?.(); // never let the keep-alive timer keep the process alive on its own
  stream.onAbort(() => void iterator.return?.());
  try {
    for (;;) {
      const { value, done } = await iterator.next();
      if (done || stream.aborted) break;
      await stream.writeSSE({
        data:
          typeof value.data === "string"
            ? value.data
            : JSON.stringify(value.data),
        event: value.event,
        id: value.id,
        retry: value.retry,
      });
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await iterator.return?.();
  }
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
