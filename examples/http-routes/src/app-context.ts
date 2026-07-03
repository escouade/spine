import type { HttpBaseContext, HttpRaw } from "@spinejs/http-gateway";
import type { ContextFactory } from "@spinejs/gateway-core";

/** This example adds a `user` to the transport context so `ctx.user` is typed in handlers. */
export interface AppContext extends HttpBaseContext {
  user: string;
}

/**
 * Register `AppContext` as the app-wide default `ctx` for every route — done ONCE, like augmenting
 * `Express.Request`. After this, the framework-level `get`/`post`/… imported straight from
 * `@spinejs/http-gateway` type their callback's `ctx` as `AppContext` with no per-file factory.
 * Drop this augmentation and `ctx` falls back to `HttpBaseContext` (no `ctx.user`).
 */
declare module "@spinejs/http-gateway" {
  interface HttpContextRegistry {
    context: AppContext;
  }
}

/** Builds one `AppContext` per HTTP call, wrapping the raw Hono context. */
export class AppContextFactory implements ContextFactory<HttpRaw, AppContext> {
  create(raw: HttpRaw): AppContext {
    return { honoCtx: raw, user: raw.req.header("x-user") ?? "anonymous" };
  }
}
