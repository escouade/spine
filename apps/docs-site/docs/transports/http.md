---
sidebar_position: 2
---

# HTTP Transport

`@spinejs/http-gateway` is the HTTP binding for `@spinejs/gateway-core`, built on [Hono](https://hono.dev). You write plain controllers with typed routes; the transport turns each route into a live HTTP endpoint and serializes the result to JSON.

Start with the usage below — the [reference](#reference) at the bottom covers the classes and types once you need them.

## Your first HTTP controller

Three small steps: register your app context once, write a controller, register it.

### 1. Register your app context

Augment the `HttpContextRegistry` **once** with your context type — like augmenting `Express.Request`. This makes it the default `ctx` of every route framework-wide, so the `get`/`post`/… you import from `@spinejs/http-gateway` type `ctx` and infer each route's `input` with no per-file factory.

```typescript
// app-context.ts
import type { HttpBaseContext } from "@spinejs/http-gateway";

export interface AppContext extends HttpBaseContext {
  user: string; // your session/user etc.
}

declare module "@spinejs/http-gateway" {
  interface HttpContextRegistry {
    context: AppContext;
  }
}
```

:::caution
Without this augmentation the default `ctx` falls back to `HttpBaseContext`, so app fields like `ctx.user` do not exist. Declare it **once per app** (like `Express.Request`).
:::

### 2. Write the controller

Declare each route as an **instance field**. Import the helpers straight from `@spinejs/http-gateway`. The callback receives `(input, ctx)`: `input` is the validated `{ params, query, body }` (only the sources you gave a schema for), `ctx` defaults to your `AppContext`. Return the plain payload — the gateway wraps it in an envelope and serializes it.

```typescript
// users.controller.ts
import { z } from "zod";
import { Controller } from "@spinejs/gateway-core";
import { get, post, del } from "@spinejs/http-gateway";
import { UsersStore } from "./users.store";
import { AdminGuard } from "./admin.guard";
import { NotFoundError } from "./not-found.error";

const userSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  role: z.enum(["admin", "member"]),
});
const createUserSchema = userSchema.omit({ id: true });

@Controller({ inject: [UsersStore] })
export class UsersController {
  constructor(private readonly users: UsersStore) {}

  // GET /users?role=admin — validated query, inferred as `{ role?: "admin" | "member" }`
  list = get(
    "/users",
    { query: z.object({ role: z.enum(["admin", "member"]).optional() }) },
    ({ query }) => this.users.list(query.role)
  );

  // GET /users/:id — path param; throw → mapped to a stable code by the ErrorMapper
  getById = get(
    "/users/:id",
    { params: z.object({ id: z.string().uuid() }) },
    ({ params }) => {
      const user = this.users.get(params.id);
      if (!user) throw new NotFoundError(`User ${params.id} not found`);
      return user;
    }
  );

  // POST /users — JSON body, 201 on success
  create = post(
    "/users",
    { body: createUserSchema, successStatus: 201 },
    ({ body }) => this.users.create(body)
  );

  // DELETE /users/:id — guarded per-route by AdminGuard
  remove = del(
    "/users/:id",
    { params: z.object({ id: z.string().uuid() }), guards: [AdminGuard] },
    ({ params }) => ({ deleted: this.users.delete(params.id) })
  );
}
```

### 3. Register it

Bind the controller to the gateway with the feature-module sugar — decorator form `@HttpModule` (named class) or factory form `httpFeature({ … })` — and add `HttpGatewayModule.configure({ … })` somewhere in the graph.

```typescript
// app.module.ts — the composition root
import type { ModuleEntry } from "@spinejs/core";
import { HttpGatewayModule, HttpModule } from "@spinejs/http-gateway";
import { AppContextFactory } from "./app-context";
import { AppErrorMapper, appStatusMapper } from "./app-error.mapper";
import { UsersController } from "./users.controller";
import { UsersStore } from "./users.store";

@HttpModule({
  controllers: [UsersController],
  providers: [UsersStore],
})
export class UsersModule {}

export const modules: ModuleEntry[] = [
  HttpGatewayModule.configure({
    imports: [],
    contextFactory: { value: new AppContextFactory() },
    errorMapper: { value: new AppErrorMapper() },
    statusMapper: { value: appStatusMapper },
    // port: 3000, // uncomment to auto-listen (App#start() calls gateway.listen())
  }),
  UsersModule,
];
```

That's a working HTTP API. `App#start()` auto-listens when `port` is set; otherwise mount the gateway's Hono `app` behind your own server. See [Feature Modules](../gateway/feature-modules) for the decorator/factory forms and [Controllers and Routes](../gateway/controllers-handlers) for the full route-option surface (`response`, per-route `guards`, `successStatus`).

## How input reaches your handler

Regardless of verb, the transport hands the pipeline a structured `{ params, query, body }` object:

- `params` — the path params (`/users/:id`).
- `query` — the parsed query string.
- `body` — the parsed JSON for body-bearing methods (`POST`/`PUT`/`PATCH`), `undefined` otherwise (a malformed body also collapses to `undefined`).

Your route's per-source schemas (`{ params }`, `{ query }`, `{ body }`) validate this object source-by-source. Each callback then receives the narrowed `input` — only the sources you declared a schema for appear, each typed as its schema's output. See [Controllers and Routes](../gateway/controllers-handlers).

### Why the helpers are a function call, not a decorator

`get`/`post`/… are **not** cosmetic typing sugar — each call does real work: it builds the route's `RouteMarker`, composing the per-source schemas into the input validator, binding the HTTP method + path, and carrying `guards`/`successStatus`/`response` as meta. `getRoutes` then picks these markers off the controller's instance fields at registration. So a route **must** go through a helper (or a hand-built `RouteMarker`) to exist at all.

Their second job is typing. The one-time `HttpContextRegistry` augmentation sets the default `ctx`, so every route's `input` is **inferred** from its schemas and `ctx` is typed with no annotation. A decorator form cannot infer the callback's parameter types this way under the project's build (stage-3 decorators / esbuild) — so the function-call form is the mechanism, not a preference. Omit `ctx` when a route does not touch it. A single route can opt out of the app context by annotating its callback's `ctx` (e.g. `(_input, ctx: HttpBaseContext) => …`); the annotation overrides the default just for that route.

## Wrapping every request: middleware & CORS

The gateway does **not** wrap CORS, logging, compression, auth headers, etc. — that is Hono's job, and `app` is exposed exactly so you mount [Hono middleware](https://hono.dev/docs/middleware/builtin/cors) yourself. There is no SpineJS-specific API to learn; anything from `hono/*` works.

To attach middleware, build the `HttpGateway` yourself in your composition root and hand it to `configure({ gateway })`. The pre-built gateway already carries its ports (context factory, error mapper, status mapper), so you no longer pass them to `configure`:

```typescript
// app.module.ts — the composition root
import type { ModuleEntry } from "@spinejs/core";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import {
  HttpGateway,
  HttpGatewayModule,
  ZodValidator,
} from "@spinejs/http-gateway";
import { AppContextFactory } from "./app-context";
import { AppErrorMapper, appStatusMapper } from "./app-error.mapper";
import { UsersModule } from "./users.module";

// The gateway now owns its ports (they were the `configure` adapters before).
const gateway = new HttpGateway(
  new ZodValidator(),
  new AppErrorMapper(),
  new AppContextFactory(),
  [],
  appStatusMapper
);

// Mount middleware on the raw Hono app BEFORE registration.
gateway.app.use("*", cors({ origin: "https://app.example.com" }));
gateway.app.use("*", logger());

export const modules: ModuleEntry[] = [
  HttpGatewayModule.configure({ imports: [], gateway: { value: gateway } }),
  UsersModule,
];
```

**Order matters.** Hono matches middleware and routes in registration order, so middleware must be attached **before** the routes it should wrap. Routes are mounted during the feature module's `onInit` (`register` → `app.on(...)`), i.e. after the gateway is built — so adding `app.use(...)` on a pre-built gateway (as above) is always early enough. Adding middleware _after_ `app.init()` would miss the already-registered routes.

## Customising the pipeline

The three ports are how you inject app concerns (context, error codes, status) without the transport knowing about them. You pass them through `HttpGatewayModule.configure()`.

### `ContextFactory` — enriching the context

```typescript
import type { ContextFactory } from "@spinejs/gateway-core";
import type { HttpBaseContext, HttpRaw } from "@spinejs/http-gateway";

export type AppContext = HttpBaseContext; // extend with session/user as needed

export class AppContextFactory implements ContextFactory<HttpRaw, AppContext> {
  create(raw: HttpRaw): AppContext {
    return { honoCtx: raw };
  }
}
```

### `ErrorMapper` + status mapper

The `ErrorMapper` converts any thrown error to a stable, transport-agnostic **code**; the **status mapper** turns that code into an HTTP status. This split keeps the code reusable across transports while the status stays HTTP-specific. Extend the default to add your own codes:

```typescript
import type { ErrorMapper } from "@spinejs/gateway-core";
import { ValidationError, UnauthorizedError } from "@spinejs/gateway-core";
import { NotFoundError } from "./not-found.error";

export type AppErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

export class AppErrorMapper implements ErrorMapper<AppErrorCode> {
  toCode(err: unknown): AppErrorCode {
    if (err instanceof NotFoundError) return "NOT_FOUND";
    if (err instanceof ValidationError) return "BAD_REQUEST";
    if (err instanceof UnauthorizedError) return "UNAUTHORIZED";
    return "INTERNAL_ERROR";
  }
}

const statusByCode: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
};
export const appStatusMapper = (code: string): number =>
  statusByCode[code as AppErrorCode] ?? 500;
```

When no `statusMapper` is given, a built-in default covers the common codes: `BAD_REQUEST` → 400, `UNAUTHORIZED` → 401, `FORBIDDEN` → 403, `NOT_FOUND` → 404, `CONFLICT` → 409, `UNPROCESSABLE` → 422, `TOO_MANY_REQUESTS` → 429, `INTERNAL_ERROR` → 500, `SERVICE_UNAVAILABLE` → 503; any unknown code falls back to 500. So a custom `ErrorMapper` that emits those codes gets the right status **without** supplying a `statusMapper` — only provide one for non-standard codes.

### `configure()` options

`configure()` supplies the app's adapters; each accepts a `ProviderAdapter` (`{ value }` or a DI `{ inject?, factory }`).

| Option           | Required | Default                             | Description                                                                                                                                                                  |
| ---------------- | -------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imports`        | Yes      | —                                   | Modules whose exports the adapters (e.g. the context factory's deps) need.                                                                                                   |
| `contextFactory` | Yes\*    | —                                   | Builds the app context from the Hono context. \*Not required when a pre-built `gateway` is given.                                                                            |
| `errorMapper`    | No       | `DefaultHttpErrorMapper`            | Maps thrown errors to stable codes.                                                                                                                                          |
| `validator`      | No       | `ZodValidator`                      | Validates the structured input; throws `ValidationError`.                                                                                                                    |
| `interceptors`   | No       | `[]`                                | Cross-cutting wrappers around every dispatch — see [Interceptors](../gateway/interceptors).                                                                                  |
| `statusMapper`   | No       | Common codes → statuses (see above) | Maps an error code to an HTTP status.                                                                                                                                        |
| `port`           | No       | `undefined` (no auto-listen)        | When set, `onStart()` calls `gateway.listen(port)`.                                                                                                                          |
| `gateway`        | No       | built from the adapters             | A pre-built `HttpGateway` (or factory). Replaces the default; lets a test hold the instance and drive `gateway.app.request()`. When given, `contextFactory` is not required. |

## Testing without a real port

Pass a pre-built gateway via `configure({ gateway })` and drive Hono's `app.request()` directly — no socket, no `listen()`:

```typescript
const gateway = new HttpGateway(
  new ZodValidator(),
  new AppErrorMapper(),
  new AppContextFactory(),
  [],
  appStatusMapper
);

const app = new App([
  HttpGatewayModule.configure({ imports: [], gateway: { value: gateway } }),
  UsersModule,
]);
await app.init();

const res = await gateway.app.request("/users?role=admin");
expect(res.status).toBe(200);
expect((await res.json()).data).toHaveLength(1);
```

## Reference

### `HttpGateway`

```typescript
class HttpGateway<
  Ctx extends HttpBaseContext = HttpBaseContext,
  Code extends string = string,
>
```

The gateway **composes** a `DispatchPipeline` (it does not extend a base class) and owns `register`/`bind`. It is app-agnostic: it knows only the Hono context; app concerns (session, user…) are injected through the `ContextFactory` port.

`bind()` mounts each route with `app.on(method, path, …)`. On dispatch it builds the context from the raw Hono context, extracts the structured input, runs the pipeline, and returns a JSON `Response` whose status is the route's `successStatus` (default `200`) on success, or `statusMapper(code)` on failure.

#### Constructor

```typescript
new HttpGateway(
  validator: Validator,
  errorMapper: ErrorMapper<Code>,
  contextFactory: ContextFactory<HttpRaw, Ctx>,
  interceptors?: GatewayInterceptor<Ctx, Code>[],
  statusMapper?: (code: Code) => number,
)
```

#### Exposed surface

- **`app`** — the underlying Hono app. Drive it directly in tests with `gateway.app.request(path, init)`, or mount it behind your own server / middleware.
- **`listen(port)`** — a convenience that starts a Node server (`@hono/node-server`). Called by the module's `onStart()` when `configure({ port })` is set.

#### Types

```typescript
interface HttpAddress {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
}
type HttpMethod = HttpAddress["method"];

// Transport-level context — app-agnostic; the app extends it via its ContextFactory.
interface HttpBaseContext extends GatewayContext {
  honoCtx: Context; // hono's Context
}

// Raw call data handed to the ContextFactory: the Hono request context.
type HttpRaw = Context;
```
