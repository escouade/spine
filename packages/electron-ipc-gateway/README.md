# @spinejs/electron-ipc-gateway

Electron IPC transport for `@spinejs/gateway-core`. Each `handle(channel, …)` route becomes an `ipcMain.handle(channel, …)` listener. It **composes** the pipeline (it does not extend a base class).

## Quick start

Register your context once, write a controller, register it.

```typescript
// electron-ipc.types.ts — register your context ONCE as the default `ctx` of every route
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

```typescript
// projects.controller.ts
import { z } from "zod";
import { Controller, UseGuards } from "@spinejs/gateway-core";
import { handle } from "@spinejs/electron-ipc-gateway";
import { SessionGuard } from "./session.guard";

@UseGuards(SessionGuard)
@Controller({ inject: [ProjectsService] })
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  list = handle("projects:list", {}, (_input, ctx) =>
    this.projects.findAll(ctx.session.userId)
  );
  create = handle(
    "projects:create",
    { input: z.object({ name: z.string().min(1) }) },
    (input, ctx) => this.projects.create(ctx.session.userId, input.name)
  );
}
```

```typescript
// projects.ipc.module.ts
import { IpcModule } from "./electron-ipc-module";
import { ProjectsController } from "./projects.controller";

@IpcModule({ controllers: [ProjectsController] })
export class ProjectsIpcModule {}
```

On the renderer, discriminate on the envelope:

```typescript
const res = await ipcRenderer.invoke("projects:list");
if (res.ok) console.log(res.data);
else console.error(res.code); // 'UNAUTHORIZED', 'SERVER', …
```

## Wiring the transport module

`ElectronIpcGatewayModule` wires the three ports and produces the gateway. Build it once per app; it defaults to `ZodValidator`. Then bind the feature helpers:

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

```typescript
// ContextFactory — enrich the context
export class SessionContextFactory
  implements ContextFactory<ElectronIpcRaw, ElectronIpcContext>
{
  constructor(private readonly sessionStore: SessionStore) {}
  create(raw: ElectronIpcRaw): ElectronIpcContext {
    return { event: raw.event, session: this.sessionStore.current() };
  }
}
```

```typescript
// ErrorMapper — no raw message ever reaches the renderer
import {
  ErrorMapper,
  UnauthorizedError,
  ValidationError,
} from "@spinejs/gateway-core";

type ErrorCode = "UNAUTHORIZED" | "INVALID_INPUT" | "NOT_FOUND" | "SERVER";

export class AppErrorMapper implements ErrorMapper<ErrorCode> {
  toCode(err: unknown): ErrorCode {
    if (err instanceof UnauthorizedError) return "UNAUTHORIZED";
    if (err instanceof ValidationError) return "INVALID_INPUT";
    if (err instanceof NotFoundError) return "NOT_FOUND";
    return "SERVER";
  }
}
```

## Reference

- Exports: `ElectronIpcGateway`, `ElectronIpcGatewayModule`, the route helper `handle` (and the deprecated `ipcRoutes` factory), `ipcFeature`, `IpcModule`, `IpcLoggingInterceptor`, `ZodValidator`, `DefaultErrorMapper`, and the `ElectronIpcBaseContext` / `ElectronIpcRaw` / `IpcContextRegistry` / `DefaultCtx` types.
- **Raw input:** `ipcRenderer.invoke(channel, arg)` → `arg` as `rawInput`; multiple args → `[a, b]`. Prefer a single object argument per call.

## Full docs

[apps/docs-site/docs/transports/electron-ipc](../../apps/docs-site/docs/transports/electron-ipc.md)
