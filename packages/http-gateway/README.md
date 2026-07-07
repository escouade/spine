# @spinejs/http-gateway

HTTP transport for `@spinejs/gateway-core`, built on [Hono](https://hono.dev). You write plain controllers with typed routes; each becomes a live HTTP endpoint and its result is serialized to JSON.

## Quick start

Top-down — entry point → root module → controller → service.

```typescript
// main.ts
import { App } from "@spinejs/core";
import { AppModule } from "./app.module";

const app = new App([AppModule]);
await app.init();
await app.start(); // listens when `port` is set (below)
```

```typescript
// app.module.ts
import { Module } from "@spinejs/core";
import { HttpGatewayModule } from "@spinejs/http-gateway";
import { AppContextFactory } from "./app-context";
import { UserModule } from "./user.module";

@Module({
  imports: [
    HttpGatewayModule.configure({
      imports: [],
      contextFactory: { value: new AppContextFactory() },
      port: 3000,
    }),
    UserModule,
  ],
})
export class AppModule {}
```

```typescript
// app-context.ts — register your context ONCE as the default `ctx` of every route
import type { HttpBaseContext, HttpRaw } from "@spinejs/http-gateway";
import type { ContextFactory } from "@spinejs/gateway-core";

export interface AppContext extends HttpBaseContext {
  user: string;
}

declare module "@spinejs/http-gateway" {
  interface HttpContextRegistry {
    context: AppContext;
  }
}

export class AppContextFactory implements ContextFactory<HttpRaw, AppContext> {
  create(raw: HttpRaw): AppContext {
    return { honoCtx: raw, user: raw.req.header("x-user") ?? "anonymous" };
  }
}
```

```typescript
// user.controller.ts
import { z } from "zod";
import { Controller } from "@spinejs/gateway-core";
import { get, post } from "@spinejs/http-gateway";
import { UserService } from "./user.service";

@Controller({ inject: [UserService] })
export class UserController {
  constructor(private readonly users: UserService) {}

  list = get("/users", {}, () => this.users.list());
  create = post(
    "/users",
    { body: z.object({ name: z.string().min(1) }), successStatus: 201 },
    ({ body }) => this.users.create(body.name)
  );
}
```

```typescript
// user.module.ts
import { HttpModule } from "@spinejs/http-gateway";
import { UserController } from "./user.controller";
import { UserService } from "./user.service";

@HttpModule({ controllers: [UserController], providers: [UserService] })
export class UserModule {}
```

```bash
curl localhost:3000/users
# {"ok":true,"data":[...]}
```

## Input

The transport hands the pipeline a structured `{ params, query, body }`. Declare per-source schemas (`{ params }`/`{ query }`/`{ body }`) and each callback receives only the sources you validated, fully typed.

## Middleware & CORS

The gateway does not wrap CORS/logging/etc. Pass HTTP-native [Hono middleware](https://hono.dev/docs/middleware/builtin/cors) to `configure({ middleware: { value: [cors(), compress()] } })`, outermost-first — it mounts on `gateway.app` before any route binds, so ordering is deterministic. For **path-scoped** middleware (`app.use("/admin/*", …)`), build the `HttpGateway` yourself and pass it via `configure({ gateway })`, attaching `app.use(...)` before registration.

## Testing

Pass a pre-built gateway via `configure({ gateway })` and drive Hono's `app.request()` — no socket, no `listen()`.

## Server-Sent Events

`sse()` declares a streaming `GET` (a peer of `get`/`post`) whose callback returns an `AsyncIterable<SseEvent>`; `SseHub` fans one event out to every open connection for a key. An SSE route reuses the route's guards + input validation but bypasses the envelope, the buffered interceptor pipeline, and the per-request CLS scope (a long-lived stream must not hold scoped resources) — except that an interceptor implementing `ConnectInterceptor` (e.g. the throttle interceptor) is run once at the connection **attempt**, before guards, so connects can be enforced without wrapping the stream.

```typescript
import { sse, SseHub } from "@spinejs/http-gateway";

@Controller({ inject: [JobsHub] })
export class JobsController {
  constructor(private readonly jobs: JobsHub) {}
  stream = sse("/jobs/stream", {}, (_input, ctx) =>
    this.jobs.subscribe(ctx.user)
  );
}

// server side: hub.publish(userId, { event: "job.updated", data: state })
```

Backpressure is bounded per subscriber (`maxQueuePerSubscriber`, default 1000, drop-oldest); a `: ping` heartbeat (`configure({ sseHeartbeatMs })`, default 15_000) keeps idle connections alive. See [SSE docs](../../apps/docs-site/docs/gateway/sse.md).

## Reference

### `HttpGatewayModule.configure()` — key options

| Option           | Required | Default                  | Description                                                                                |
| ---------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `contextFactory` | Yes\*    | —                        | Builds the app context from the Hono context.                                              |
| `errorMapper`    | No       | `DefaultHttpErrorMapper` | Maps thrown errors to stable codes.                                                        |
| `validator`      | No       | `ZodValidator`           | Validates the structured input.                                                            |
| `interceptors`   | No       | `[]`                     | Cross-cutting wrappers around every dispatch (per-request; also SSE connect).              |
| `middleware`     | No       | `[]`                     | HTTP-native Hono middleware (helmet/compression/CORS), outermost-first, before route bind. |
| `statusMapper`   | No       | common codes → statuses  | Maps an error code to an HTTP status.                                                      |
| `port`           | No       | `undefined`              | When set, `onStart()` calls `gateway.listen(port)`.                                        |
| `sseHeartbeatMs` | No       | `15_000`                 | Keep-alive `: ping` interval for SSE streams (`0` disables).                               |
| `gateway`        | No       | built from adapters      | A pre-built `HttpGateway` (for middleware/tests). \*Then `contextFactory` is not required. |

Exports: `HttpGateway`, `HttpGatewayModule`, the route helpers `get`/`post`/`put`/`patch`/`del`/`sse` (and the deprecated `httpRoutes` factory), `SseHub`, `httpFeature`, `HttpModule`, `ZodValidator`, `DefaultHttpErrorMapper`, and the `HttpBaseContext` / `HttpRaw` / `HttpContextRegistry` / `DefaultCtx` / `SseEvent` / `SseHubOptions` / `SseRouteOptions` types.

## Full docs

[apps/docs-site/docs/transports/http](../../apps/docs-site/docs/transports/http.md)
