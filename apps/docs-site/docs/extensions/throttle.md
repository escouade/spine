---
sidebar_position: 6
---

# Throttle (rate limiting)

`@spinejs/throttle` sheds abusive traffic with **exact sliding-window** policies enforced as a gateway
interceptor. A policy means precisely what it says — _at most `limit` accepted requests per key per
`windowMs`_ — so there is no approximate token bucket to reason about. It is **off by default**: no
configuration means no interceptor in the chain and zero overhead. The core is transport-blind; the
`./http` and `./electron-ipc` presets add the address/sender key sources and, for HTTP, the standard
`RateLimit-*` headers.

## Protect a login route

Rate limiting is one interceptor placed **first** (outermost) in a gateway's `interceptors`. Configure
the policies, wire the interceptor token, and declare per-route protection next to the route:

```typescript
// src/main.ts
import { App } from "@spinejs/core";
import { AppModule } from "./app.module";

await new App([AppModule]).start();
```

```typescript
// src/app.module.ts
import { Module } from "@spinejs/core";
import { HttpGatewayModule, httpFeature } from "@spinejs/http-gateway";
import { ThrottleModule, throttleInterceptorRef } from "@spinejs/throttle";
import { throttleHttp } from "@spinejs/throttle/http";
import { AuthController } from "./auth.controller";

@Module({
  imports: [
    // 1. Declare the policies. `throttleHttp()` wires the `'ip'` key source AND turns on the
    //    draft-6 `RateLimit-*` + `Retry-After` headers (presentation lives on `./http`).
    ThrottleModule.configure({
      policies: {
        global: { limit: 100, windowMs: 60_000, keyBy: "ip", scope: "gateway" },
      },
      ...throttleHttp(),
    }),
    // 2. Place the interceptor FIRST in the gateway (outermost — rejected requests are cheap).
    HttpGatewayModule.configure({
      imports: [
        /* your context-factory module */
      ],
      contextFactory: {
        /* ... */
      },
      interceptors: {
        inject: [throttleInterceptorRef()],
        factory: (throttle) => [throttle],
      },
    }),
    httpFeature({ controllers: [AuthController] }),
  ],
})
export class AppModule {}
```

```typescript
// src/auth.controller.ts
import { Controller } from "@spinejs/gateway-core";
import { post } from "@spinejs/http-gateway";
import "@spinejs/throttle/http"; // makes `throttle` a typed route option

@Controller({})
export class AuthController {
  // A route-inline policy lives next to the route it protects: 5 attempts / 15 min per address.
  login = post(
    "/login",
    { throttle: { policies: [{ limit: 5, windowMs: 900_000, keyBy: "ip" }] } },
    ({ body }) => this.auth.login(body)
  );
}
```

Over the limit, the request fails with `429 Too Many Requests` **before** any guard, validation or
handler runs, carrying `Retry-After` and draft-6 `RateLimit-Limit` / `-Remaining` / `-Reset` headers.
The `global` gateway policy and the route-inline `login` policy are evaluated independently — either one
exhausting rejects the request.

:::info 429 before 400
Enforcement is the **outermost** interceptor, so it runs before validation. An over-limit request that
is _also_ malformed gets a `429`, not a `400` — the abuse is shed before any work, invalid or not.
:::

## Do

### A global gateway quota

A `scope: 'gateway'` policy shares **one bucket per key across every route** — the app-wide quota. It is
declarable only in `configure` (never route-inline):

```typescript
ThrottleModule.configure({
  policies: {
    global: { limit: 100, windowMs: 60_000, keyBy: "ip", scope: "gateway" },
  },
  ...throttleHttp(),
});
```

A default policy _without_ `scope: 'gateway'` is `scope: 'route'` — one bucket per key **per route
target**, so `/a` and `/b` count separately under the same named default.

### Per-route policies, skip, and opt-out

Every route helper — HTTP verbs, `sse()`, and IPC `handle()` — takes the same `throttle` option:

```typescript
// Add route-inline policies (scoped `routeId#index`, non-overridable):
post(
  "/login",
  { throttle: { policies: [{ limit: 5, windowMs: 900_000, keyBy: "ip" }] } },
  fn
);

// Disable ONE named gateway default for this route:
get("/health", { throttle: { skip: ["global"] } }, fn);

// Re-tune a named default for this route only:
get("/report", { throttle: { override: { global: { limit: 10 } } } }, fn);

// Opt out of ALL defaults:
get("/status", { throttle: false }, fn);
```

The helper copies your fields **verbatim** into `meta.throttle` and stamps one field — `routeId`
(`"METHOD /path"` for HTTP, the channel string for IPC). The transport never interprets it; only the
throttle interceptor reads the key.

### Per-channel IPC policies

The IPC `handle()` helper has the same option — full parity with HTTP routes. Import the preset so
`throttle` is typed, and key by the renderer (`'sender'`):

```typescript
// src/api.controller.ts
import { Controller } from "@spinejs/gateway-core";
import { handle } from "@spinejs/electron-ipc-gateway";
import "@spinejs/throttle/electron-ipc"; // makes `throttle` a typed handle() option

@Controller({})
export class ApiController {
  sync = handle(
    "data:sync",
    {
      throttle: {
        policies: [{ limit: 10, windowMs: 60_000, keyBy: "sender" }],
      },
    },
    ({ payload }) => this.data.sync(payload)
  );
}
```

Wire the key source the same way as HTTP, minus the header presentation:

```typescript
ThrottleModule.configure({
  policies: {
    /* optional gateway defaults */
  },
  keySources: { sender: senderKeySource() }, // from @spinejs/throttle/electron-ipc
});
```

`keyBy: 'ip'` on the IPC transport is a **boot error** — an IPC call has no address. Use `'sender'`.

### The IPC rejection contract

Over the limit, an IPC call resolves to a failure envelope — a **stable public contract** you map into
your app's error union:

```typescript
{ ok: false, code: "TOO_MANY_REQUESTS", meta: { retryAfterMs: 1000 } }
```

`code` is always `"TOO_MANY_REQUESTS"`; `meta.retryAfterMs` is the relative delay (ms) after which the
client may retry. Extend your app's error-code union with a retryable throttle code and implement real
backoff instead of guessing:

```typescript
// src/renderer/errors.ts — extend an existing app error union (studio `CommandErrorCode` style)
export type CommandErrorCode = "VALIDATION" | "NOT_FOUND" | "TOO_MANY_REQUESTS";

async function callWithBackoff<T>(
  invoke: () => Promise<Envelope<T>>
): Promise<T> {
  for (;;) {
    const res = await invoke();
    if (res.ok) return res.data;
    if (res.code !== "TOO_MANY_REQUESTS") throw new AppError(res.code);
    // Honor the server's hint exactly — one wait of `retryAfterMs` clears the window.
    await sleep(res.meta?.retryAfterMs ?? 1000);
  }
}
```

### Custom keys and the null-skip bypass

`keyBy` can be a function `(ctx, rawInput) => string | null`. It receives the **raw pre-validation
input**; returning `null` skips the policy for that request:

```typescript
// Rate-limit authenticated users by id, and let anonymous requests fall through to the address policy.
{ limit: 1000, windowMs: 60_000, keyBy: (ctx) => ctx.user?.id ?? null }
```

Pair an identity policy (`null` for anonymous) with an address policy so an anonymous flood still hits a
key — never leave a route keyed only by a selector that can return `null`.

### Enforce SSE connections

The main `interceptors` array never runs on an SSE stream (ADR 0017) — but the throttle interceptor
implements `ConnectInterceptor`, so the **same instance** in `interceptors` is automatically run at the
SSE **connect** attempt. Nothing extra to wire:

```typescript
HttpGatewayModule.configure({
  imports: [
    /* ... */
  ],
  contextFactory: {
    /* ... */
  },
  interceptors: {
    inject: [throttleInterceptorRef()],
    factory: (throttle) => [throttle], // enforced at request AND at SSE connect — one engine, one store
  },
});
```

The connection attempt is enforced before guards; stream **events** are never counted. A denied connect
gets a `429` envelope with `Retry-After`, exactly like a buffered route. Declare a stream's policy with
`sse("/stream", { throttle: { ... } }, fn)`. A request-only interceptor (one that does not implement
`ConnectInterceptor`, e.g. a unit-of-work holding a transaction) is never run at connect.

### Validate route-inline specs at boot

Boot fails on a bad **configure** policy out of the box (non-positive limit, duplicate name, `'ip'` on
IPC, …). To also validate **route-inline** specs at startup — so a typo fails the boot, not the first
dispatch — place the throttle **meta validator** in the gateway's `metaValidators`, alongside the
interceptor in `interceptors`, on the **same** gateway:

```typescript
import {
  throttleInterceptorRef,
  throttleMetaValidatorRef,
} from "@spinejs/throttle";

HttpGatewayModule.configure({
  imports: [
    ThrottleModule.configure({
      policies: {
        /* ... */
      },
      ...throttleHttp(),
    }),
  ],
  contextFactory: {
    /* ... */
  },
  interceptors: {
    inject: [throttleInterceptorRef()],
    factory: (throttle) => [throttle], // runtime enforcement (per request / per SSE connect)
  },
  metaValidators: {
    inject: [throttleMetaValidatorRef()],
    factory: (validator) => [validator], // boot-time validation of every route's `meta.throttle`
  },
});
```

`metaValidators` is a framework primitive ([`MetaValidator`](../gateway/interceptors.md#validate-route-meta-at-boot)):
at start, the gateway crosses **its own** routes against **its own** validators and fails boot with the
route named on any bad `meta.throttle` (an unwired `keyBy`, a `skip`/`override` naming an unknown
default, an exotic `override` value). Because the validator lives on the gateway that _enforces_
throttling, the validated routes are exactly the enforced routes — a multi-gateway app never
cross-validates. Use the matching name for a named instance: `throttleMetaValidatorRef("public")`.

### Observe rejections

```typescript
ThrottleModule.configure({
  policies: {
    /* ... */
  },
  onLimitReached: ({ policyName, routeId, keyHash, retryAfterMs }) => {
    metrics.increment("throttle.rejected", { policyName, routeId });
  },
  onError: ({ policyName, phase, error }) => {
    // A throwing key selector or a store outage — fail-closed telemetry so an outage is never silent.
    logger.error(`throttle ${phase} failure on ${policyName}`, error);
  },
});
```

`keyHash` is the stored SHA-256 hash, never the raw key (PII). Opt into the raw key with
`emitRawKey: true` only when you must. Both hooks are non-load-bearing: a throwing observer never breaks
enforcement.

### Multiple gateways

Give each gateway its own isolated instance with `name` — config never merges across instances:

```typescript
ThrottleModule.configure({
  name: "public",
  policies: {
    /* ... */
  },
  ...throttleHttp(),
});
ThrottleModule.configure({
  name: "admin",
  policies: {
    /* ... */
  },
  ...throttleHttp(),
});
// Wire each gateway with throttleInterceptorRef("public") / throttleInterceptorRef("admin").
```

## Reference

### `ThrottleModule.configure(options): DynamicModule`

| Option           | Type                              | Notes                                                                                         |
| ---------------- | --------------------------------- | --------------------------------------------------------------------------------------------- |
| `policies`       | `Record<string, ThrottlePolicy>`  | Gateway-default policies, keyed by unique name. Names may not contain `#`.                    |
| `store`          | `ThrottleStore`                   | Custom store (e.g. Redis). Default: the built-in in-memory sliding-log store (module-owned).  |
| `keySources`     | `Record<string, KeySelector>`     | Named sources a string `keyBy` resolves through (`'ip'`/`'sender'` from the presets).         |
| `onLimitReached` | `(e: LimitReachedEvent) => void`  | Fired on every rejection: `{ policyName, routeId, keyHash, retryAfterMs }`.                   |
| `onError`        | `(e: ThrottleErrorEvent) => void` | Fired on a throwing selector / store failure (fail-closed **and** fail-open telemetry).       |
| `onOutcome`      | `(ctx) => void`                   | Invoked once per dispatch after the outcome slot is written (the `./http` header translator). |
| `emitRawKey`     | `boolean`                         | Also pass the raw pre-hash key to `onLimitReached`. Off by default (PII).                     |
| `clock`          | `Clock`                           | Injectable time source for the default store (monotonic default) — deterministic tests.       |
| `name`           | `string`                          | Instance name for multi-gateway apps; each name is fully isolated (config never merges).      |

To validate route-inline specs at boot, place `throttleMetaValidatorRef(name)` in the gateway's
`metaValidators` (see [Validate route-inline specs at boot](#validate-route-inline-specs-at-boot)) —
it is exported by `configure` next to `throttleInterceptorRef(name)`, not a `configure` option.

### `ThrottlePolicy`

| Field      | Type                    | Default       | Notes                                                                               |
| ---------- | ----------------------- | ------------- | ----------------------------------------------------------------------------------- |
| `limit`    | `number`                | —             | Max accepted hits per key per window. Positive integer, ≤ 10 000 (sanity ceiling).  |
| `windowMs` | `number`                | —             | Sliding window length (ms). Positive.                                               |
| `keyBy`    | `string \| KeySelector` | —             | A wired key-source name, or `(ctx, rawInput) => string \| null` (`null` = skip).    |
| `scope`    | `"route" \| "gateway"`  | `"route"`     | `'gateway'` = one bucket per key across all routes (configure-only).                |
| `failOpen` | `boolean`               | `false`       | On a store/selector failure: fail-closed (reject) by default; `true` skips instead. |
| `maxKeys`  | `number`                | store default | Max tracked keys in this policy's isolated LRU space. Positive integer.             |

### The `throttle` route option

Available on HTTP verb helpers, `sse()`, and IPC `handle()` once the matching preset
(`@spinejs/throttle/http` or `.../electron-ipc`) is imported.

| Field      | Type                                      | Notes                                                                   |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------------- |
| `policies` | `ThrottlePolicy[]`                        | Route-inline policies, scoped `routeId#index`, non-overridable.         |
| `skip`     | `string[]`                                | Named gateway defaults disabled for this route.                         |
| `override` | `Record<string, Partial<ThrottlePolicy>>` | Named gateway defaults re-tuned for this route (enforced route-scoped). |
| — or —     | `false`                                   | Opt out of every default policy for this route.                         |

### `./http` preset

- `throttleHttp(options?)` — spread into `configure`: wires the `'ip'` key source **and** the
  outcome→headers translator (on by default). Options: `trustProxy`, `ipv6PrefixBits`, `headers`
  (`false` disables all header emission), extra `keySources`.
- `ipKeySource(options?)` — the `'ip'` key source alone (direct socket by default; `trustProxy` for
  reverse proxies; IPv4-mapped/NAT64 normalization before the IPv6 /56 mask).
- `rateLimitHeaders(options?)` — the standalone outcome→headers translator (for a custom `onOutcome`).
- `THROTTLE_STATUS_MAPPING` — the `{ TOO_MANY_REQUESTS: 429 }` a custom http-gateway `statusMapper`
  must carry. Spread it into your own mapper.

### `./electron-ipc` preset

- `senderKeySource()` — the `'sender'` key source (keys by `event.sender.id`).

### `./testing`

A reusable store contract-test kit pinning the `consume` semantics (atomicity, relative `resetMs`,
accepted-hits-only growth, unconditional consumption). Run it against any custom store to validate it.

The in-memory store keeps limits **per process** — several replicas each enforce their own window. For a
shared limit across instances, implement the `ThrottleStore` port over a shared backend (e.g. Redis) and
validate it with the `./testing` kit.
