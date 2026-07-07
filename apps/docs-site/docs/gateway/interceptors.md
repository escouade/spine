---
sidebar_position: 4
---

# Interceptors

Interceptors wrap the `dispatch()` pipeline and are the canonical place for cross-cutting concerns: logging, metrics, tracing, auditing, and response transformation. You write an object with an `intercept()` method that calls `next()`, then register it through the transport module's `configure({ interceptors })`. Reach for one whenever logic should run around **every** route rather than inside one.

## Writing an interceptor

An interceptor is any object that implements the `GatewayInterceptor` interface. It receives the dispatch target, the context, the raw input, and a `next()` that runs the rest of the chain — do your work before and/or after calling it:

```typescript
import type {
  Envelope,
  GatewayContext,
  LoadedRoute,
} from "@spinejs/gateway-core";
import { GatewayInterceptor } from "@spinejs/gateway-core";

// A portable interceptor that only touches `ctx` can implement `GatewayInterceptor` with the default
// target. One that reads the route's `address`/`meta` narrows the target to `LoadedRoute`:
class LoggingInterceptor
  implements GatewayInterceptor<GatewayContext, string, LoadedRoute>
{
  async intercept(
    route: LoadedRoute,
    ctx: GatewayContext,
    rawInput: unknown,
    next: () => Promise<Envelope<unknown>>
  ): Promise<Envelope<unknown>> {
    console.debug("→", route.address, rawInput);
    const envelope = await next();
    console.debug(
      "←",
      route.address,
      envelope.ok ? "ok" : `error:${envelope.code}`
    );
    return envelope;
  }
}
```

The interceptor's first argument is the dispatch **target**. It defaults to the transport-agnostic `DispatchTarget` (guards + input + invoke); narrow it to `LoadedRoute<Ctx, Addr>` when you need the route's `address` or `meta`, as above.

`next()` delegates to the next interceptor in the chain, or — if this is the last one — to the core pipeline (guards → validate → invoke). Always return the result of `next()` (or a replacement envelope) so the chain completes.

## Transport-agnostic interceptors

An interceptor that only touches `ctx`/`next` — never the route — is **transport-agnostic**: its type is the base `GatewayInterceptor<GatewayContext, …>` (e.g. `ClsInterceptor`, `MikroOrmInterceptor`). You add it to any transport's `interceptors` array **as-is, no cast**. Each transport narrows its slot to its own context + route, but the slot's element type is a `ChainInterceptor` — a union that admits either a transport-specific interceptor **or** a base transport-agnostic one:

```typescript
import type { ChainInterceptor } from "@spinejs/gateway-core";
// exported for reference; you rarely name it — it is the type the transport slots already use.
```

This is why `configure({ interceptors: [new ClsInterceptor(cls), ormInterceptor] })` type-checks with no `as`, even though `ormInterceptor` is typed at the base `GatewayContext` and the slot is narrowed to the transport's route.

## Enforcing at connect (SSE)

An HTTP SSE stream bypasses the buffered `interceptors` pipeline (a stream is many values, not one `Envelope` — see [ADR 0017](https://github.com/escouade/spine/blob/main/docs/adr/0017-sse-fan-out-in-http-gateway.md)). An interceptor that must also act on the **connection attempt** — e.g. rate-limiting a connect — opts in by implementing `ConnectInterceptor` alongside `GatewayInterceptor`:

```typescript
import type {
  GatewayInterceptor,
  ConnectInterceptor,
} from "@spinejs/gateway-core";

class ThrottleInterceptor implements GatewayInterceptor, ConnectInterceptor {
  intercept(target, ctx, rawInput, next) {
    return this.gate(target, ctx, rawInput, next);
  }
  interceptConnect(target, ctx, rawInput, next) {
    return this.gate(target, ctx, rawInput, next); // same logic, run at connect
  }
  private gate(target, ctx, rawInput, next) {
    /* deny → return a failure envelope; or `return next()` to allow the connection */
  }
}
```

The HTTP gateway derives its connect chain from the **same** `interceptors` list, filtered to those implementing `interceptConnect` — so you wire the interceptor **once**. An interceptor that does **not** implement `ConnectInterceptor` (a request-scoped `MikroOrmInterceptor`, whose transaction must not span a long-lived stream) is excluded from the connect chain **by default** — the filter only picks up interceptors that expose `interceptConnect`. At connect, `next()` resolves to a synthetic accept — there is no downstream handler — so short-circuit to deny, or call `next()` to allow.

An interceptor that should act **only** at connect (nothing on buffered requests) still lives in the `interceptors` list, so give it a pass-through request method: `intercept(t, c, i, next) { return next(); }`. Connect-phase enforcement is a subset of `interceptors`, not an independent list.

## Execution order

Interceptors are chained in registration order. The first interceptor in the array is the outermost wrapper — it runs first on the way in and last on the way out:

```
[Interceptor A] → [Interceptor B] → guards → validate → invoke → [B returns] → [A returns]
```

## Wiring via `ElectronIpcGatewayModule.configure()`

Pass interceptors through the `configure()` call. The `interceptors` option follows the same adapter pattern as the other ports — it accepts a plain `value` or a DI `factory` with an `inject` list:

```typescript
import { loggerToken, Logger } from "@spinejs/core";
import {
  ElectronIpcGatewayModule,
  IpcLoggingInterceptor,
} from "@spinejs/electron-ipc-gateway";

ElectronIpcGatewayModule.configure({
  imports: [SessionModule],
  contextFactory: {
    /* … */
  },
  errorMapper: {
    /* … */
  },
  interceptors: {
    inject: [loggerToken],
    factory: (logger: Logger) => [new IpcLoggingInterceptor(logger)],
  },
});
```

When `interceptors` is omitted, the gateway runs with no interceptors.

## `IpcLoggingInterceptor`

`@spinejs/electron-ipc-gateway` ships a ready-to-use logging interceptor. It logs every IPC dispatch at `debug` level using SpineJS's `Logger`:

```
→ conversations:messages {"conversationId":"abc123"}
← conversations:messages ok
→ chat:send {"content":"hello"}
← chat:send error:SERVER
```

Wire it as shown above. The interceptor uses the SpineJS `loggerToken` so it picks up the same logger instance as the rest of the app.

### Redacting sensitive inputs

By default the raw input is logged verbatim at `debug` level — passwords or tokens sent over IPC would land in the logs. Pass an `IpcLogRedactor` as the second constructor argument to mask what gets logged; it receives the channel, so redaction can be per-channel. The real input passed to the handler is never touched:

```typescript
import {
  IpcLoggingInterceptor,
  IpcLogRedactor,
} from "@spinejs/electron-ipc-gateway";

const redact: IpcLogRedactor = (channel, input) =>
  channel.startsWith("auth:") ? "[redacted]" : input;

interceptors: {
  inject: [loggerToken],
  factory: (logger: Logger) => [new IpcLoggingInterceptor(logger, redact)],
},
```

```
→ auth:login "[redacted]"
← auth:login ok
→ chat:send {"content":"hello"}
← chat:send ok
```

The framework stays policy-free: the app decides which channels or fields to mask.

## Writing custom interceptors

Interceptors can inject any service and perform arbitrary async work before and after the pipeline. They may also short-circuit by returning an envelope without calling `next()`:

```typescript
import {
  GatewayInterceptor,
  Envelope,
  GatewayContext,
  LoadedRoute,
} from "@spinejs/gateway-core";
import { MetricsService } from "../metrics";

export class MetricsInterceptor
  implements GatewayInterceptor<GatewayContext, string, LoadedRoute>
{
  constructor(private readonly metrics: MetricsService) {}

  async intercept(
    route: LoadedRoute,
    ctx: GatewayContext,
    rawInput: unknown,
    next: () => Promise<Envelope<unknown>>
  ): Promise<Envelope<unknown>> {
    const start = Date.now();
    const envelope = await next();
    this.metrics.record(route.address, Date.now() - start, envelope.ok);
    return envelope;
  }
}
```

Interceptors are not DI-resolved automatically — you instantiate them in the `factory` of the `interceptors` adapter and inject their dependencies via `inject`.
