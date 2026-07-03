# Example — CLS request context over the electron IPC gateway

Runnable example of `@spinejs/cls`: per-request ambient data without a DI request scope and without
threading `ctx` through every service. See [ADR 0003](../../docs/adr/0003-cls-request-context.md) for
the rationale.

- The app declares its store shape once (`interface DispatchStore { user, reqId }`) and a `DispatchContext`
  class (`extends ClsService<DispatchStore>`, empty body — just a typed DI token), aliased to the same
  `ClsService` singleton via `{ provide: DispatchContext, existing: ClsService }` — no factory, no extra
  object, `get`/`set` key-checked against `DispatchStore`.
- `@spinejs/cls`'s generic `ClsInterceptor` opens the scope per dispatch; no hand-written interceptor
  class — only a `seed` function mapping the dispatch context to the store (here adding a generated
  `reqId`).
- The singleton `AuditService` reads `dispatchContext.get("user")` — no `ctx` parameter — and still
  sees the right user per request, even under concurrency, because `AsyncLocalStorage` isolates by
  async context, not by instance.
- `@spinejs/core` and `@spinejs/gateway-core` are untouched: the scope rides the gateway's existing
  interceptor hook.

## Run

`electron` is mocked via `@spinejs/electron-ipc-gateway/testing`, so the real `ElectronIpcGateway`
runs without an Electron process:

```bash
npx nx test example-cls-request-context
```

The spec fires two concurrent `whoami` invokes (alice + bob) and asserts each sees its own user.
