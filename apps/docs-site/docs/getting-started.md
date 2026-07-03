---
sidebar_position: 2
---

# Getting Started

This walkthrough builds a tiny but complete SpineJS app: an HTTP API with one resource, from an empty folder to a live request. We go top-down — the way you actually build: entry point first, then the root module, then a controller, then the service behind it.

By the end you will have a `GET /users` and `POST /users` served over HTTP, with validated input and typed handlers, in this layout:

```
src/
  main.ts
  app-context.ts
  modules/
    app.module.ts
    user/
      user.module.ts
      user.controller.ts
      user.service.ts
```

## Install

```bash
yarn add @spinejs/core @spinejs/http-gateway zod
```

- `@spinejs/core` — the module system, DI container, and `App` orchestrator.
- `@spinejs/http-gateway` — the HTTP transport (built on [Hono](https://hono.dev)).
- `zod` — the schema library used to validate input.

## 1. The entry point — `main.ts`

`App` takes your root module, builds the graph, and drives the lifecycle. `port` on the gateway (wired next) makes it listen on `start()`.

```typescript
// src/main.ts
import { App } from "@spinejs/core";
import { AppModule } from "./modules/app.module";

const app = new App([AppModule]);

await app.init(); // build the graph, register routes
await app.start(); // listen
```

`SIGINT`/`SIGTERM` shut the app down cleanly — `onStop()` runs in reverse order, no `process.exit()` needed.

## 2. The root module — `modules/app.module.ts`

`AppModule` is plain composition: it imports the HTTP transport (configured once) and your feature module. Add more feature modules to `imports` as the app grows.

```typescript
// src/modules/app.module.ts
import { Module } from "@spinejs/core";
import { HttpGatewayModule } from "@spinejs/http-gateway";
import { AppContextFactory } from "../app-context";
import { UserModule } from "./user/user.module";

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

Your app context is registered **once** so it becomes the default `ctx` of every route (like augmenting `Express.Request`). Put that augmentation (and the context factory referenced above) in a shared file:

```typescript
// src/app-context.ts
import type { HttpBaseContext, HttpRaw } from "@spinejs/http-gateway";
import type { ContextFactory } from "@spinejs/gateway-core";

// Start with the transport's base context; add session/user here.
export interface AppContext extends HttpBaseContext {
  user: string;
}

// Register AppContext as the default `ctx` of every route (once per app).
declare module "@spinejs/http-gateway" {
  interface HttpContextRegistry {
    context: AppContext;
  }
}

// Builds your context from the raw Hono request.
export class AppContextFactory implements ContextFactory<HttpRaw, AppContext> {
  create(raw: HttpRaw): AppContext {
    return { honoCtx: raw, user: raw.req.header("x-user") ?? "anonymous" };
  }
}
```

## 3. The controller — `modules/user/user.controller.ts`

Each route is an **instance field** built by a helper. The callback gets the validated `input` and returns a plain value — the gateway wraps it and serializes to JSON.

```typescript
// src/modules/user/user.controller.ts
import { z } from "zod";
import { Controller } from "@spinejs/gateway-core";
import { get, post } from "@spinejs/http-gateway";
import { UserService } from "./user.service";

@Controller({ inject: [UserService] })
export class UserController {
  constructor(private readonly users: UserService) {}

  // GET /users
  list = get("/users", {}, () => this.users.list());

  // POST /users — body validated, inferred as { name: string }
  create = post(
    "/users",
    { body: z.object({ name: z.string().min(1) }), successStatus: 201 },
    ({ body }) => this.users.create(body.name)
  );
}
```

## 4. The service — `modules/user/user.service.ts`

Plain class, marked `@Injectable` so the container can construct it and inject it into the controller.

```typescript
// src/modules/user/user.service.ts
import { Injectable } from "@spinejs/core";

export interface User {
  id: string;
  name: string;
}

@Injectable()
export class UserService {
  private users: User[] = [{ id: "1", name: "Ada" }];

  list() {
    return this.users;
  }

  create(name: string): User {
    const user = { id: String(this.users.length + 1), name };
    this.users.push(user);
    return user;
  }
}
```

## 5. Wire the feature module — `modules/user/user.module.ts`

`@HttpModule` ties the controller and its providers to the gateway. This is the `UserModule` imported by `AppModule` in step 2.

```typescript
// src/modules/user/user.module.ts
import { HttpModule } from "@spinejs/http-gateway";
import { UserController } from "./user.controller";
import { UserService } from "./user.service";

@HttpModule({
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
```

## 6. Run it

Start the app, then hit the API:

```bash
curl localhost:3000/users
# {"ok":true,"data":[{"id":"1","name":"Ada"}]}

curl -X POST localhost:3000/users -H 'content-type: application/json' -d '{"name":"Linus"}'
# {"ok":true,"data":{"id":"2","name":"Linus"}}
```

## What you just used

| Piece                  | What it did                                                   | Learn more                                             |
| ---------------------- | ------------------------------------------------------------- | ------------------------------------------------------ |
| `App` + lifecycle      | Built the module graph and ran `init → start → stop`          | [Lifecycle](core/lifecycle)                            |
| `@Module` / imports    | Composed the transport and feature modules                    | [Modules](core/modules)                                |
| `@Controller` + routes | Declared handlers as typed fields                             | [Controllers and Routes](gateway/controllers-handlers) |
| `get`/`post` + schemas | Typed and validated `input`                                   | [Validation](gateway/validation)                       |
| `@Injectable` / DI     | Constructed `UserService` and injected it into the controller | [Dependency Injection](core/dependency-injection)      |

## Next steps

- Add **auth** with a [Guard](gateway/guards).
- Add cross-cutting logging/metrics with an [Interceptor](gateway/interceptors).
- Understand the request pipeline in the [Gateway overview](gateway/overview).
- Reuse the same **services and guards** over Electron IPC — see [Electron IPC Transport](transports/electron-ipc). Routes are re-declared in the IPC vocabulary (`handle("channel", …)` instead of `get`/`post`).
