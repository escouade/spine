# SpineJS

[![CI](https://github.com/dev-studio-ai/spine/actions/workflows/ci.yml/badge.svg)](https://github.com/dev-studio-ai/spine/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Lightweight, NestJS-flavored micro-framework for structuring Node processes.

Brings the patterns you know from NestJS — modules, dependency injection, lifecycle hooks — without the weight of the full NestJS runtime or its HTTP-first assumptions.

Works equally well in background workers, CLI tools, desktop app main processes, serverless functions, or any Node program that outgrows a flat `index.ts`.

## Quick start

An HTTP API, top-down — the way you build: entry point → root module → controller → service.

```typescript
// src/main.ts
import { App } from "@spinejs/core";
import { AppModule } from "./modules/app.module";

const app = new App([AppModule]);
await app.init();
await app.start();
// SIGINT/SIGTERM handled — onStop() runs in reverse order, then the process exits
```

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

```typescript
// src/modules/user/user.controller.ts
import { z } from "zod";
import { Controller } from "@spinejs/gateway-core";
import { get, post } from "../../app-context"; // httpRoutes<AppContext>() helpers
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

The same **services, guards, and feature-module wiring** carry over to Electron IPC — you re-declare the routes with `handle("channel", …)` from `@spinejs/electron-ipc-gateway` instead of the HTTP `get`/`post` path routes. See the [**Getting Started**](https://dev-studio-ai.github.io/spine/docs/getting-started) guide for the full walkthrough (service, feature module, and `curl`).

## Why SpineJS?

Node processes grow quickly. What starts as a flat script soon needs a config loader, logging, multiple cooperating services, and a clean shutdown path. NestJS solves these problems, but pulls in `reflect-metadata`, a full HTTP stack, and several hundred kilobytes of runtime you may not need.

SpineJS answers the same architectural questions at a fraction of the weight:

- **No `reflect-metadata`.** Decorators store metadata as plain own-property symbols — safe under esbuild/swc without a global polyfill.
- **No transport lock-in.** The gateway pipeline decouples your controllers from whatever carries the bytes — IPC, HTTP, WebSocket, or nothing at all.
- **Structured lifecycle.** Every module participates in `init → start → stop`. Graceful shutdown, signal handling, and error propagation are handled for you.

## Packages

| Package                                                          | Role                                                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| [`@spinejs/core`](packages/core)                                 | Module system, DI container, `App` orchestrator, lifecycle hooks, built-in logger             |
| [`@spinejs/gateway-core`](packages/gateway-core)                 | Transport-agnostic pipeline building blocks: `@Controller`, field routes, `@UseGuards`, ports |
| [`@spinejs/http-gateway`](packages/http-gateway)                 | HTTP transport (Hono) — composes the pipeline onto HTTP routes                                |
| [`@spinejs/electron-ipc-gateway`](packages/electron-ipc-gateway) | Electron IPC transport — composes the pipeline onto `ipcMain.handle`                          |
| [`@spinejs/electron`](packages/electron)                         | `ElectronModule` (window + lifecycle) and `WindowService`                                     |
| [`@spinejs/config`](packages/config)                             | Typed, async-capable config loading                                                           |
| [`@spinejs/winston-logger`](packages/winston-logger)             | Drop-in `Logger` implementation backed by Winston                                             |
| [`@spinejs/cls`](packages/cls)                                   | Per-request context via `AsyncLocalStorage`                                                   |

## Documentation

Full docs are published at **[dev-studio-ai.github.io/spine](https://dev-studio-ai.github.io/spine/)**.

Source lives in [`apps/docs-site/`](apps/docs-site/) (Docusaurus). Architecture Decision Records are in [`docs/adr/`](docs/adr/).

```bash
yarn docs:dev
```

## Development

```bash
yarn install
yarn typecheck:all
yarn test:all
yarn lint:all
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, branch/PR conventions, and docs requirements.
