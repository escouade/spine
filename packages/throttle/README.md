# @spinejs/throttle

Rate limiting for SpineJS gateways: declare named policies, place one interceptor, get exact
sliding-window 429s with `Retry-After` and `RateLimit-*` headers — off by default, zero overhead
when unconfigured.

```ts
// src/main.ts
import { ThrottleModule, throttleInterceptorRef } from "@spinejs/throttle";
import type { ThrottleInterceptor } from "@spinejs/throttle";
import { HttpGatewayModule } from "@spinejs/http-gateway";

HttpGatewayModule.configure({
  imports: [
    ThrottleModule.configure({
      policies: {
        global: { limit: 100, windowMs: 60_000, keyBy: "ip", scope: "gateway" },
      },
      keySources: {
        /* wired from @spinejs/throttle/http — see the docs */
      },
    }),
  ],
  interceptors: {
    inject: [throttleInterceptorRef()],
    // First = outermost: rejected requests consume no guard/validation/handler work.
    factory: (throttle: ThrottleInterceptor) => [throttle],
  },
  // ...contextFactory, port
});
```

A policy is a plain object: `{ limit, windowMs, keyBy }` — at most `limit` accepted hits per key
inside a sliding `windowMs` window, exactly (sliding-window log, no approximation). `keyBy` names a
wired key source (`'ip'` from `@spinejs/throttle/http`, `'sender'` from
`@spinejs/throttle/electron-ipc`, `'identity'` wired by your app) or is a custom
`(ctx, rawInput) => string | null` selector.

Full guides (route options, custom keys, the store port, IPC error mapping) live in the SpineJS
documentation site.

## Subpath exports

| Import                           | Contents                                                          |
| -------------------------------- | ----------------------------------------------------------------- |
| `@spinejs/throttle`              | policy types, module, interceptor, store/clock ports, outcome ctx |
| `@spinejs/throttle/http`         | `'ip'` key source + `RateLimit-*`/`Retry-After` header translator |
| `@spinejs/throttle/electron-ipc` | `'sender'` key source                                             |
| `@spinejs/throttle/testing`      | store contract kit for custom store implementations               |
