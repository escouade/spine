---
sidebar_position: 5
---

# Feature Modules

Feature modules are the glue between your controllers and a gateway transport. They encapsulate the wiring: instantiate controllers via DI, resolve guard instances, build the guard map, and register the resulting routes on the gateway — all in a synthesized `onInit()`.

`@spinejs/gateway-core` provides two sugar functions that produce this wiring from a transport-specific binding:

| Function                                   | Style                                        | When to use                                         |
| ------------------------------------------ | -------------------------------------------- | --------------------------------------------------- |
| `gatewayFeatureFactory(token, transport)`  | Factory — returns a `DynamicModule`          | Inline feature registration, no named class needed. |
| `gatewayModuleDecorator(token, transport)` | Decorator — replaces a class with a subclass | NestJS-style, keeps a named `export class`.         |

Both are bound once per transport to produce the app-specific helpers (`ipcFeature` / `@IpcModule` in the reference app).

## Creating transport-specific helpers

Bind the generic functions to your transport's gateway class and module:

```typescript
// electron-ipc-module.ts
import {
  gatewayFeatureFactory,
  gatewayModuleDecorator,
} from "@spinejs/gateway-core";
import { ElectronIpcGateway } from "@spinejs/electron-ipc-gateway";
import { ElectronIpcGatewayModule } from "./electron-ipc-gateway.module";

/**
 * Factory form — no named module class:
 *   imports: [ ipcFeature({ controllers: [PingController] }) ]
 */
export const ipcFeature = gatewayFeatureFactory(
  ElectronIpcGateway,
  ElectronIpcGatewayModule
);

/**
 * Decorator form — keeps a named module class:
 *   @IpcModule({ controllers: [PingController] })
 *   export class PingModule {}
 */
export const IpcModule = gatewayModuleDecorator(
  ElectronIpcGateway,
  ElectronIpcGatewayModule
);
```

## `ipcFeature` — factory form

The factory form is the primitive. It produces a `DynamicModule` that can be passed directly to `imports`:

```typescript
import { Module } from "@spinejs/core";
import { ipcFeature } from "./electron-ipc-module";
import { HealthController } from "./health.controller";
import { UserController } from "./user.controller";

@Module({
  imports: [
    ipcFeature({ controllers: [HealthController] }),
    ipcFeature({
      controllers: [UserController],
      imports: [UserModule], // additional imports needed by UserController
    }),
  ],
})
export class AppModule {}
```

## `@IpcModule` — decorator form

The decorator form replaces the decorated class with a subclass that has the synthesized `onInit`. You keep a named, exportable module class:

```typescript
import { IpcModule } from "./electron-ipc-module";
import { ProjectsController } from "./projects.controller";
import { ProjectsModule } from "./projects.module";
import { SessionGuard } from "../session.guard";

@IpcModule({
  controllers: [ProjectsController],
  imports: [ProjectsModule],
})
export class ProjectsIpcModule {}
```

## `FeatureModuleConfig`

Both forms accept the same config object:

```typescript
interface FeatureModuleConfig extends ModuleMetadata {
  controllers: ProviderConstructor[];
}
```

| Field         | Type                    | Description                                                                                             |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `controllers` | `ProviderConstructor[]` | Controller classes to register. Required.                                                               |
| `imports`     | `ModuleEntry[]`         | Additional modules to import into this feature module.                                                  |
| `providers`   | `ProviderEntry[]`       | Additional providers beyond the controllers.                                                            |
| `exports`     | `Token[]`               | Tokens to export from this feature module.                                                              |
| `inject`      | `Token[]`               | Additional constructor deps for the module class (decorator form only, for the user's own constructor). |

## How the synthesized `onInit()` works

When the feature module initializes, the framework:

1. Builds the DI inject order `[gatewayToken, ...controllerClasses, ...userInject]` and receives the resolved instances.
2. Reads its **own container** (stamped by the core module loader on a hidden slot just before `onInit`).
3. Scans each controller instance for the guard classes it references — class-level `@UseGuards` plus per-route `guards` on the field markers — resolving each from that container (registering an unknown guard class on demand), to build the `guardMap: Map<GuardConstructor, Guard>`.
4. For each controller, calls `getRoutes(controllerInstance, guardMap)` to produce `LoadedRoute[]`.
5. Calls `gateway.register(routes)` with all routes.
6. If the user's class (decorator form) has its own `onInit()`, calls it afterwards.

## Full wiring example

Here is a complete IPC feature module with guards, an authenticated context, and multiple controllers:

```typescript
// projects.ipc.module.ts
import { IpcModule } from "../infrastructure/electron-ipc-module";
import { SessionGuard } from "../infrastructure/session.guard";
import { ProjectsController } from "./projects.controller";
import { IssuesController } from "./issues.controller";
import { ProjectsModule } from "./projects.module";

@IpcModule({
  controllers: [ProjectsController, IssuesController],
  imports: [ProjectsModule],
})
export class ProjectsIpcModule {}
```

```typescript
// projects.controller.ts
import { Controller, UseGuards } from "@spinejs/gateway-core";
import { SessionGuard } from "../infrastructure/session.guard";
import { handle } from "@spinejs/electron-ipc-gateway";
import { z } from "zod";

const createProjectSchema = z.object({ name: z.string().min(1) });

@UseGuards(SessionGuard)
@Controller({ inject: [ProjectsService] })
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  list = handle("projects:list", {}, (_input, ctx) =>
    this.projectsService.findAll(ctx.session.userId)
  );

  create = handle(
    "projects:create",
    { input: createProjectSchema },
    (input, ctx) => this.projectsService.create(ctx.session.userId, input.name)
  );
}
```

```typescript
// main.module.ts
import { Module } from "@spinejs/core";
import { ProjectsIpcModule } from "./projects.ipc.module";

@Module({
  imports: [ProjectsIpcModule],
})
export class MainModule {}
```

## Guard resolution

You do not need to list guard classes in the `providers` array manually. At `onInit`, the feature module scans the controller instances for every referenced guard class — class-level `@UseGuards` **and** per-route `guards` options — and resolves each from its own container, registering an unknown class on demand.

Guards must still declare their own dependencies via `@Injectable` on the guard class, and those dependencies must be reachable from the feature module's container (its imports' exports + providers) — the container resolves them through the normal provider chain. A guard whose dependency is not reachable fails at `onInit` with a clear error.
