---
sidebar_position: 1
---

# Electron IPC Transport

`@spinejs/electron-ipc-gateway` is the Electron IPC binding for `@spinejs/gateway-core`. You write plain controllers with `handle(channel, …)` routes; the transport attaches each one to `ipcMain.handle(channel, ...)` so it becomes a live IPC channel.

Start with the usage below — the [reference](#reference) at the bottom covers the class and types once you need them.

## Your first IPC controller

Register your app context once, write a controller, register it.

### 1. Register your app context

Augment the `IpcContextRegistry` **once** with your context type — like augmenting `Express.Request`. This makes it the default `ctx` of every route, so the `handle` you import from `@spinejs/electron-ipc-gateway` types `ctx` and infers each route's `input` with no per-file factory.

```typescript
// electron-ipc.types.ts
import type { ElectronIpcBaseContext } from "@spinejs/electron-ipc-gateway";

export interface ElectronIpcContext extends ElectronIpcBaseContext {
  session: { userId: string };
}

declare module "@spinejs/electron-ipc-gateway" {
  interface IpcContextRegistry {
    context: ElectronIpcContext;
  }
}
```

:::caution
Without this augmentation the default `ctx` falls back to `ElectronIpcBaseContext`, so app fields like `ctx.session` do not exist. Declare it **once per app**.
:::

### 2. Write the controller

Each route is an **instance field**. Import `handle` straight from `@spinejs/electron-ipc-gateway`. The callback receives `(input, ctx)`: `input` is the validated payload, `ctx` defaults to your context. Return the plain value — the gateway wraps it in an envelope.

```typescript
import { Controller, UseGuards } from "@spinejs/gateway-core";
import { z } from "zod";
import { handle } from "@spinejs/electron-ipc-gateway";
import { SessionGuard } from "../infrastructure/session.guard";

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

### 3. Register it

Bind the controller to the gateway with the feature-module sugar — decorator form `@IpcModule` or factory form `ipcFeature({ … })`:

```typescript
// projects.ipc.module.ts
import { IpcModule } from "../infrastructure/electron-ipc-module";
import { ProjectsController } from "./projects.controller";
import { ProjectsModule } from "./projects.module";

@IpcModule({
  controllers: [ProjectsController],
  imports: [ProjectsModule],
})
export class ProjectsIpcModule {}
```

On the renderer, invoke the channel and discriminate on the envelope:

```typescript
const result = await ipcRenderer.invoke("projects:list");
if (result.ok) console.log(result.data);
else console.error(result.code); // e.g. 'UNAUTHORIZED', 'SERVER'
```

See [Feature Modules](../gateway/feature-modules) for the decorator/factory forms and [Controllers and Routes](../gateway/controllers-handlers) for the full route surface.

## Wiring the transport module

`ElectronIpcGatewayModule` is the transport module. It wires the three ports and produces the `ElectronIpcGateway` instance. You build it once per application and put all its app-specific adapters there.

```typescript
import { Logger, loggerToken, Module, InjectionToken } from "@spinejs/core";
import { ContextFactory, ErrorMapper, Validator } from "@spinejs/gateway-core";
import { ElectronIpcGateway } from "@spinejs/electron-ipc-gateway";
import { ZodValidator } from "./zod.validator";
import { ElectronIpcErrorMapper } from "./electron-ipc-error.mapper";
import { SessionContextFactory } from "./session.context-factory";
import { SessionStore } from "../session";

const validatorToken = new InjectionToken<Validator>("validator");
const errorMapperToken = new InjectionToken<ErrorMapper<ErrorCode>>(
  "error-mapper"
);
const contextFactoryToken = new InjectionToken<
  ContextFactory<ElectronIpcRaw, ElectronIpcContext>
>("context-factory");

@Module({
  imports: [SessionModule],
  providers: [
    { provide: validatorToken, factory: () => new ZodValidator() },
    { provide: errorMapperToken, factory: () => new ElectronIpcErrorMapper() },
    {
      provide: contextFactoryToken,
      inject: [SessionStore],
      factory: (session: SessionStore) => new SessionContextFactory(session),
    },
    {
      provide: ElectronIpcGateway,
      inject: [
        validatorToken,
        errorMapperToken,
        contextFactoryToken,
        loggerToken,
      ],
      factory: (
        validator: ZodValidator,
        errorMapper: ElectronIpcErrorMapper,
        contextFactory: SessionContextFactory,
        logger: Logger
      ) =>
        new ElectronIpcGateway(validator, errorMapper, contextFactory, logger),
    },
  ],
  exports: [ElectronIpcGateway],
})
export class ElectronIpcGatewayModule {}
```

Bind the feature-module helpers to this gateway and module once:

```typescript
// electron-ipc-module.ts
import {
  gatewayFeatureFactory,
  gatewayModuleDecorator,
} from "@spinejs/gateway-core";
import { ElectronIpcGateway } from "@spinejs/electron-ipc-gateway";
import { ElectronIpcGatewayModule } from "./electron-ipc-gateway.module";

export const ipcFeature = gatewayFeatureFactory(
  ElectronIpcGateway,
  ElectronIpcGatewayModule
);
export const IpcModule = gatewayModuleDecorator(
  ElectronIpcGateway,
  ElectronIpcGatewayModule
);
```

## Implementing the ports

The ports are how you inject app concerns (context, error codes) without the transport knowing about them.

### `ContextFactory` — enriching the context

Transforms the raw Electron event into a typed context your controllers receive:

```typescript
import { ContextFactory } from "@spinejs/gateway-core";
import { ElectronIpcRaw } from "@spinejs/electron-ipc-gateway";

export interface ElectronIpcContext extends ElectronIpcBaseContext {
  session: Session | null;
}

export class SessionContextFactory
  implements ContextFactory<ElectronIpcRaw, ElectronIpcContext>
{
  constructor(private readonly sessionStore: SessionStore) {}

  create(raw: ElectronIpcRaw): ElectronIpcContext {
    return {
      event: raw.event,
      session: this.sessionStore.current(),
    };
  }
}
```

### `ErrorMapper` — mapping errors to codes

Converts any thrown error to a stable code string. No raw error message ever reaches the renderer:

```typescript
import {
  ErrorMapper,
  UnauthorizedError,
  ValidationError,
} from "@spinejs/gateway-core";

type ErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "SERVER"
  | "NETWORK";

export class ElectronIpcErrorMapper implements ErrorMapper<ErrorCode> {
  toCode(err: unknown): ErrorCode {
    if (err instanceof ValidationError) return "INVALID_INPUT";
    if (err instanceof UnauthorizedError) return "UNAUTHORIZED";
    if (err instanceof NotFoundError) return "NOT_FOUND";
    if (err instanceof TypeError) return "NETWORK";
    return "SERVER";
  }
}
```

### Enforcing auth with a guard

Since the `ContextFactory` already enriches the context with the session, a guard only needs to check it:

```typescript
import { Guard } from "@spinejs/gateway-core";
import { ElectronIpcContext } from "./electron-ipc.types";

export class SessionGuard implements Guard<ElectronIpcContext> {
  canActivate(ctx: ElectronIpcContext): boolean {
    return ctx.session !== null;
  }
}
```

Applied via `@UseGuards(SessionGuard)` on a controller (as in the first example), every route is guaranteed `ctx.session !== null`. See [Guards](../gateway/guards).

## Full application example

```typescript
// main.ts
import { App } from "@spinejs/core";
import { ElectronModule } from "@spinejs/electron";
import { ConfigModule } from "@spinejs/config";
import { MainModule } from "./modules/main.module";

const app = new App(
  [
    ConfigModule.configure({ configs: [appConfig] }),
    ElectronModule.configure({
      window: {
        width: 1280,
        height: 800,
        webPreferences: {
          preload: join(__dirname, "preload.js"),
          contextIsolation: true,
        },
      },
      devUrl: "http://localhost:5173",
      packagePath: join(__dirname, "../renderer/index.html"),
    }),
    MainModule,
  ],
  { handleProcessExit: false }
);

await app.init();
await app.start();
```

```typescript
// main.module.ts
import { Module, OnInit } from "@spinejs/core";
import { ElectronModule } from "@spinejs/electron";
import { ipcFeature, IpcModule } from "./infrastructure/electron-ipc-module";
import { HealthController } from "./interface/health.controller";
import { ProjectsModule } from "./domain/projects.module";
import { AuthModule } from "./domain/auth.module";

@Module({
  imports: [
    ElectronModule,
    AuthModule,
    ProjectsModule,
    // Factory form — inline, no named class:
    ipcFeature({ controllers: [HealthController] }),
    // Decorator form — named module:
    ProjectsIpcModule,
    AuthIpcModule,
  ],
  inject: [ElectronModule],
})
export class MainModule implements OnInit {
  constructor(private readonly electronModule: ElectronModule) {}

  async onInit(): Promise<void> {
    this.electronModule.createMainWindow();
  }
}
```

## Reference

### `ElectronIpcGateway`

```typescript
class ElectronIpcGateway<
  Ctx extends ElectronIpcBaseContext = ElectronIpcBaseContext,
  Code extends string = string,
>
```

The gateway **composes** a `DispatchPipeline` (it does not extend a base class) and owns `register`/`bind`. It is app-agnostic: it knows `ipcMain` and the Electron event, but nothing about sessions or users. App concerns are injected through the `ContextFactory` port.

#### Constructor

```typescript
new ElectronIpcGateway(
  validator: Validator,
  errorMapper: ErrorMapper<Code>,
  contextFactory: ContextFactory<ElectronIpcRaw, Ctx>,
  logger: Logger,
  interceptors?: GatewayInterceptor<Ctx, Code>[],
)
```

The constructor is called via a factory provider — the class itself has no `@Injectable` decorator, keeping it transport-generic.

#### Types

```typescript
// Base context — always available.
interface ElectronIpcBaseContext extends GatewayContext {
  event: IpcMainInvokeEvent;
}

// Raw call data passed to the ContextFactory.
interface ElectronIpcRaw {
  event: IpcMainInvokeEvent;
  args: unknown[];
}
```

### Raw input normalization

When `ipcRenderer.invoke(channel, arg1)` sends a single argument, the gateway passes `arg1` directly as `rawInput`. When multiple arguments are sent (`ipcRenderer.invoke(channel, arg1, arg2)`), they are passed as an array `[arg1, arg2]`. Your schema and handler should be designed accordingly.

:::tip Single-argument convention
Stick to a single object argument per IPC call. This maps cleanly to a zod object schema and avoids the array ambiguity. For example: `ipcRenderer.invoke('users:create', { name: 'Alice', email: 'alice@example.com' })`.
:::
