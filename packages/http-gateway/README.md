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

The gateway does not wrap CORS/logging/etc. — mount [Hono middleware](https://hono.dev/docs/middleware/builtin/cors) on the exposed `gateway.app` yourself. Build the `HttpGateway` in your composition root and pass it via `configure({ gateway })`; attach `app.use(...)` **before** registration.

## Testing

Pass a pre-built gateway via `configure({ gateway })` and drive Hono's `app.request()` — no socket, no `listen()`.

## Reference

### `HttpGatewayModule.configure()` — key options

| Option           | Required | Default                  | Description                                                                                |
| ---------------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------ |
| `contextFactory` | Yes\*    | —                        | Builds the app context from the Hono context.                                              |
| `errorMapper`    | No       | `DefaultHttpErrorMapper` | Maps thrown errors to stable codes.                                                        |
| `validator`      | No       | `ZodValidator`           | Validates the structured input.                                                            |
| `statusMapper`   | No       | common codes → statuses  | Maps an error code to an HTTP status.                                                      |
| `port`           | No       | `undefined`              | When set, `onStart()` calls `gateway.listen(port)`.                                        |
| `gateway`        | No       | built from adapters      | A pre-built `HttpGateway` (for middleware/tests). \*Then `contextFactory` is not required. |

Exports: `HttpGateway`, `HttpGatewayModule`, the route helpers `get`/`post`/`put`/`patch`/`del` (and the deprecated `httpRoutes` factory), `httpFeature`, `HttpModule`, `ZodValidator`, `DefaultHttpErrorMapper`, and the `HttpBaseContext` / `HttpRaw` / `HttpContextRegistry` / `DefaultCtx` types.

## Full docs

[apps/docs-site/docs/transports/http](../../apps/docs-site/docs/transports/http.md)
