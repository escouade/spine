---
sidebar_position: 2
---

# Controllers and Routes

Controllers are the classes that group your incoming-message handling logic. They are declared with `@Controller` and expose individual routes as **instance fields** built by a transport's typed route helpers (`get`/`post`/… for HTTP, `handle` for IPC).

:::tip
For an end-to-end walkthrough (service → controller → running server), start with [Getting Started](../getting-started). This page is the full reference for declaring controllers and routes.
:::

:::info Field-form routes
Routes are declared as **fields**, not decorated methods. A field helper (`get(...)`, `handle(...)`, …) is a function call, so it can **infer** the handler's `input` type from the route's zod schema — one source of truth, checked at compile time, with no `reflect-metadata`. See ADR 0004 (`docs/adr/0004-field-form-routes.md`) for the rationale. The old `@Handler` method decorator has been removed.
:::

## `@Controller()`

`@Controller` marks a class as a gateway controller **and** folds in `@Injectable`, so the same decorator declares the class as a DI provider with its typed constructor dependencies.

```typescript
import { Controller } from "@spinejs/gateway-core";

@Controller({ inject: [UsersStore] })
export class UsersController {
  constructor(private readonly users: UsersStore) {}
  // routes as fields…
}
```

`inject` is typed exactly like `@Injectable` — a wrong token type, order, or arity is a compile error. A bare `@Controller()` (no deps) is also valid. A controller class must be listed in the `controllers` array of a feature module (see [Feature Modules](./feature-modules)); the gateway resolves controller instances via DI.

## Declaring routes with a route helper

Each transport exports framework-level route helpers you import directly. Their callback's `ctx` defaults to your **app context**, which you register **once** via a `declare module` augmentation (like `Express.Request`):

```typescript
// app-context.ts
import type { HttpBaseContext } from "@spinejs/http-gateway";

export interface AppContext extends HttpBaseContext {
  user: string;
}

// Register AppContext as the default `ctx` of every route (once per app).
declare module "@spinejs/http-gateway" {
  interface HttpContextRegistry {
    context: AppContext;
  }
}
```

:::caution
Without this augmentation the default `ctx` falls back to the transport base (`HttpBaseContext` / `ElectronIpcBaseContext`), so app fields like `ctx.user` do not exist. Declare it once per app.
:::

Then import the helpers from the transport package and declare routes as fields. The callback takes the validated **`input` first** and **`ctx` last**, both fully typed without annotation:

```typescript
import { z } from "zod";
import { Controller } from "@spinejs/gateway-core";
import { get, post } from "@spinejs/http-gateway";

const listQuery = z.object({ role: z.enum(["admin", "member"]).optional() });
const createBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

@Controller({ inject: [UsersStore] })
export class UsersController {
  constructor(private readonly users: UsersStore) {}

  // GET /users?role=admin — `query` is inferred as { role?: "admin" | "member" }
  list = get("/users", { query: listQuery }, ({ query }) =>
    this.users.list(query.role)
  );

  // POST /users — `body` inferred; 201 on success
  create = post(
    "/users",
    { body: createBody, successStatus: 201 },
    ({ body }) => this.users.create(body)
  );
}
```

- **`input`** is the validated input, split by source for HTTP (`{ params, query, body }` — only the sources you declared a schema for appear). Each key is typed as its schema's inferred output.
- **`ctx`** is the transport context, defaulting to your registered app context. A route that ignores it just writes `(input) => …`; one that needs it writes `(input, ctx) => …`. To opt a single route out of the app context, annotate its `ctx` (e.g. `(_input, ctx: HttpBaseContext) => …`) — the annotation overrides the default for that route only.

Because the helpers are arrow-friendly fields initialized in the constructor scope, `this` (and thus injected services like `this.users`) is available inside the callback.

## Route options

The second argument is the route **options** object. For HTTP:

| Option          | Type                       | Description                                                                                       |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `params`        | `ParseableSchema<P>`       | Schema for path params (`/users/:id`). When present, `input.params` is validated and typed.       |
| `query`         | `ParseableSchema<Q>`       | Schema for the query string. When present, `input.query` is validated and typed.                  |
| `body`          | `ParseableSchema<B>`       | Schema for the JSON body (POST/PUT/PATCH). When present, `input.body` is validated and typed.     |
| `response`      | `ParseableSchema<unknown>` | Reserved for OpenAPI generation — carried in the marker `meta`, **never** validated.              |
| `guards`        | `GuardConstructor[]`       | Per-route guards, merged after the controller's class-level `@UseGuards`. See [Guards](./guards). |
| `successStatus` | `number`                   | HTTP status for a successful envelope. Defaults to `200` (e.g. `201` for a creation).             |
| `headers`       | `Record<string, string>`   | Static response headers added on a successful envelope. Override the default `Content-Type`.      |

IPC routes (`handle`) take a single `input` schema instead of the split sources (an IPC call carries one payload), plus the same `response` and `guards`.

## Input validation with `ParseableSchema<T>`

A schema is anything with a `parse(input: unknown): T` method — the structural contract zod satisfies, so the gateway library infers your types **without importing zod**. HTTP composes the per-source schemas (`params`/`query`/`body`) into one validator over the structured input; each source is validated independently.

When validation fails, the `Validator` port (e.g. `ZodValidator`) throws a `ValidationError`, which the pipeline maps to your `BAD_REQUEST` code (HTTP 400 by default). The handler callback is never called.

:::note Schema inference
The handler's `input` type flows from the schemas object you pass at the call site. Omit a source and its key disappears from `input` entirely; provide it and the key is typed as that schema's `parse` return type. No explicit annotation on the callback parameter.
:::

## Handler return values

A handler may return a plain value or a `Promise`. The pipeline wraps the resolved value in `{ ok: true, data: value }`. Throwing any error (or returning a rejected promise) returns `{ ok: false, code: <mapped code> }` instead — the error is mapped by the transport's `ErrorMapper`.

```typescript
getVersion = get("/version", {}, () => "1.0.0");
// → { ok: true, data: "1.0.0" }

load = get("/data", {}, async () => await fetchData());
// → { ok: true, data: {...} }  or  { ok: false, code: "INTERNAL_ERROR" }
```
