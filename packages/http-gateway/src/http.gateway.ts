import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Context as HonoCtx } from "hono";
import {
  DispatchPipeline,
  LoadedRoute,
  Validator,
  ErrorMapper,
  GatewayInterceptor,
  ContextFactory,
} from "@spinejs/gateway-core";
import type { HttpAddress, HttpBaseContext, HttpRaw } from "./http-base.types";
import type { HttpRouteMeta } from "./http-routes";

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
    validator: Validator,
    errorMapper: ErrorMapper<Code>,
    private readonly contextFactory: ContextFactory<HttpRaw, Ctx>,
    interceptors: GatewayInterceptor<Ctx, Code, HttpRoute<Ctx>>[] = [],
    private readonly statusMapper: (
      code: Code
    ) => number = defaultStatusMapper as (code: Code) => number
  ) {
    this.pipeline = new DispatchPipeline<Ctx, Code, HttpRoute<Ctx>>(
      validator,
      errorMapper,
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
