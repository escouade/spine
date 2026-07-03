---
sidebar_position: 1
---

# Gateway Overview

`@spinejs/gateway-core` provides a protocol-independent inbound data pipeline that sits between your application logic and the communication layer (IPC, HTTP, WebSocket, or any custom transport). It defines a consistent message/response contract without binding to any particular runtime.

## What you write

You write plain controllers with typed route fields — no transport details leak in:

```typescript
@Controller({ inject: [UsersStore] })
export class UsersController {
  constructor(private readonly users: UsersStore) {}

  // Route field — HTTP get/post here; IPC declares the same logic with handle("channel", …).
  list = get("/users", {}, () => this.users.list());
}
```

The gateway takes each incoming call and runs it through a fixed pipeline — enrich context → check guards → validate input → invoke your handler → wrap the result in an envelope — then hands the envelope back to the transport. You declare the handler; the pipeline does the rest.

New here? Follow the [Getting Started](../getting-started) guide for a runnable HTTP app, then come back for the design details below.

:::info `@spinejs/gateway-core` ships building blocks, not a base class
This package is not instantiated or extended directly. It ships the **building blocks** to build a gateway: the `DispatchPipeline` (guards → validate → invoke → envelope), the ports (`Validator`, `ContextFactory`, `ErrorMapper`), the DI route-loader (`@Controller`, field-route markers, `@UseGuards`) and the feature-module sugar. A **concrete gateway** — `HttpGateway`, `ElectronIpcGateway` — composes these blocks and owns its own bind/register. See ADR 0005 (`docs/adr/0005-gateway-composition-http-transport.md`).
:::

## How a request flows

A common mistake is to write transport handlers that directly call application services, scatter guard logic across each handler, and pass raw transport-specific objects (an IPC event, an HTTP request, a socket message) to business code. The gateway eliminates this coupling by establishing a clear pipeline with explicit responsibilities.

```
Raw transport call
  │
  ▼
ContextFactory.create(raw)        ← enriches the call with app context (session, user, …)
  │
  ▼
Guards: canActivate(ctx)?         ← authorization checks (DI-resolved, composable)
  │
  ▼
Validator.validate(schema, input) ← input narrowing (zod, or any parse()-compatible schema)
  │
  ▼
Route handler invocation          ← your controller field route, receiving (input, ctx)
  │
  ▼
Envelope<T, Code>                 ← { ok: true, data } | { ok: false, code }
  │
  ▼
Transport sends the envelope back
```

The shared `DispatchPipeline.dispatch()` implements this pipeline. It **never throws**: any error — guard rejection, validation failure, handler exception — is caught and mapped to a stable error code via `ErrorMapper`. The caller always receives an `Envelope`.

:::info Why an envelope, not a thrown error?
Transport boundaries (IPC, HTTP) serialize poorly across thrown exceptions and leak stack traces. Returning a discriminated `Envelope` keeps the contract explicit and the error surface stable for every consumer.
:::

## `Envelope<T, Code>`

Every handler returns its result wrapped in an `Envelope`:

```typescript
type Envelope<T, Code extends string = string> =
  | { ok: true; data: T }
  | { ok: false; code: Code };
```

On the renderer side (or any consumer of the transport), you discriminate on `ok`:

```typescript
const result = await ipcRenderer.invoke("users:list");
if (result.ok) {
  console.log(result.data); // User[]
} else {
  console.error(result.code); // e.g. 'UNAUTHORIZED', 'SERVER', 'INVALID_INPUT'
}
```

Error codes are application-defined strings — the gateway core never leaks raw error messages or stack traces to the transport consumer.

## Transport-agnostic design

The pipeline is a **composable helper**, not a base class. `DispatchPipeline<Ctx, Code>` owns the cross-transport core (guards → validate → invoke → envelope) and the interceptor chain. A transport **holds** a pipeline and calls `dispatch()` from its own listener:

```typescript
class HttpGateway<Ctx, Code> {
  private readonly pipeline = new DispatchPipeline<Ctx, Code>(
    validator,
    errorMapper,
    interceptors
  );

  register(routes: LoadedRoute<Ctx>[]) {
    for (const route of routes) this.bind(route); // attach a transport listener per route
  }
}
```

Each transport owns address extraction, context building, and emitting the envelope; only `dispatch()` is shared. A controller's **services, guards, and structure** carry across transports unchanged — but its **routes are transport-specific**: HTTP uses path-based `get`/`post` with `{ params, query, body }` input, while Electron IPC uses channel-based `handle` with a single payload. You re-declare the routes in the target transport's vocabulary; the business logic they call does not change.

## Ports

Three interfaces define the extension points of the gateway. Your transport module provides concrete implementations:

| Port                       | Responsibility                                                             |
| -------------------------- | -------------------------------------------------------------------------- |
| `ContextFactory<Raw, Ctx>` | Builds a typed context from the transport's raw call data.                 |
| `Validator`                | Validates raw input against a schema; throws `ValidationError` on failure. |
| `ErrorMapper<Code>`        | Maps any thrown error to a stable error code string.                       |

The transport module wires these implementations into the gateway via DI factory providers. Controller and feature module code never touches the ports directly.

## Error types

Two error classes are part of the gateway's public API:

| Class               | When to throw                                                          |
| ------------------- | ---------------------------------------------------------------------- |
| `ValidationError`   | Thrown by the `Validator` when schema parsing fails.                   |
| `UnauthorizedError` | Thrown by the pipeline when a guard's `canActivate()` returns `false`. |

Application code may throw its own error types; the `ErrorMapper` catches all of them and maps them to codes.
