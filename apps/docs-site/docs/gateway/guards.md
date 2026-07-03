---
sidebar_position: 3
---

# Guards

Guards decide whether an incoming message may proceed to the handler. You write a small class with a `canActivate()` method and attach it to a controller (all its routes) or to a single route. Guards are resolved by DI, so they can inject services like any other provider.

## Defining a guard

A guard is a plain class with one method. Return `true` to allow the message, `false` to reject it — a `false` makes the pipeline throw `UnauthorizedError`, which the `ErrorMapper` maps to your unauthorized code (typically `'UNAUTHORIZED'`). It can inject any provider via its constructor:

```typescript
import { Guard } from "@spinejs/gateway-core";
import { Injectable } from "@spinejs/core";
import { SessionStore } from "../session";
import type { AppContext } from "./app-context";

@Injectable({ inject: [SessionStore] })
export class SessionGuard implements Guard<AppContext> {
  constructor(private readonly sessionStore: SessionStore) {}

  canActivate(ctx: AppContext): boolean {
    // ctx.session is enriched by the ContextFactory from the session store.
    return ctx.session !== null;
  }
}
```

The contract is a single method:

```typescript
interface Guard<Ctx extends GatewayContext> {
  canActivate(ctx: Ctx): boolean | Promise<boolean>;
}
```

Guards may also throw directly (e.g. to distinguish between different unauthorized conditions); the `ErrorMapper` handles those throws the same way as a `false` return.

## Applying guards

A guard class can be applied at two levels. Both accept guard **classes** (not instances); the container resolves the instances during feature module initialization.

### Class-level — `@UseGuards`

Attaching `@UseGuards` to the controller class applies the guards to **every** route on it — the common case for authenticating a whole controller:

```typescript
import { Controller, UseGuards } from "@spinejs/gateway-core";
import { get } from "./app-context";
import { SessionGuard } from "./session.guard";

@UseGuards(SessionGuard)
@Controller({ inject: [ProjectsStore] })
export class ProjectsController {
  constructor(private readonly projects: ProjectsStore) {}

  // SessionGuard runs before every route below.
  list = get("/projects", {}, (_input, ctx) =>
    this.projects.findAll(ctx.session.userId)
  );
  getById = get("/projects/:id", { params: idParam }, ({ params }) =>
    this.projects.findById(params.id)
  );
}
```

:::note Class-only decorator
`@UseGuards` is a **class** decorator. Because routes are instance fields (not methods), there is no method-level decorator target — per-route granularity lives in the route options instead (below).
:::

### Per-route — the `guards` option

Pass `guards: [...]` in a route's options to add guards to that single route. They are merged **after** the controller's class-level guards:

```typescript
import { Controller, UseGuards } from "@spinejs/gateway-core";
import { get, post } from "./app-context";
import { SessionGuard } from "./session.guard";
import { AdminGuard } from "./admin.guard";

@UseGuards(SessionGuard)
@Controller({ inject: [AdminStore] })
export class AdminController {
  constructor(private readonly store: AdminStore) {}

  // SessionGuard + AdminGuard
  reset = post("/admin/reset", { guards: [AdminGuard] }, () =>
    this.store.reset()
  );

  // SessionGuard only
  status = get("/admin/status", {}, () => "ok");
}
```

## Guard resolution

At feature module initialization (inside `onInit()`), the framework:

1. Scans each controller **instance** for the guard classes it references — class-level (`@UseGuards`) plus the per-route `guards` on its field markers.
2. Resolves each guard from the feature module's own container, registering an unknown guard class on demand so its `@Injectable` dependencies resolve from that container (its imports' exports + providers).
3. Builds a `Map<GuardConstructor, Guard<Ctx>>` and passes it to `getRoutes()`, which attaches each route's resolved guard list.

Guards are singletons within the module scope — the same `SessionGuard` instance is reused across every route that references it.

:::note Why lazy resolution
Per-route guard classes live inside controller fields, so they are only known **after** the controller is instantiated. The feature module therefore resolves guards lazily at `onInit` (via its own container), rather than collecting them statically at module-definition time. A guard whose dependency is not reachable from the module container fails at init with a clear error.
:::

## Combining multiple guards

Multiple guards are checked in order: class-level first, then per-route. The first guard to return `false` short-circuits — subsequent guards are not called.

```typescript
@UseGuards(AuthenticatedGuard, RateLimitGuard)
@Controller()
export class PublicApiController {
  // Guard order: AuthenticatedGuard → RateLimitGuard → CsrfGuard
  mutate = post(
    "/api/mutate",
    { body: mutateBody, guards: [CsrfGuard] },
    ({ body }) => this.service.mutate(body)
  );
}
```
