## 0.1.5 (2026-07-07)

### 🚀 Features

- ⚠️  **gateway:** ConnectInterceptor capability marker for SSE connect enforcement (Design 4′) ([ae8dd2d](https://github.com/escouade/spine/commit/ae8dd2d))
- ⚠️  **gateway:** MetaValidator — boot-time route-meta validation primitive ([e2692b5](https://github.com/escouade/spine/commit/e2692b5))

### 🩹 Fixes

- **throttle:** malformed route-inline meta throws ThrottleConfigError, not TypeError (post-merge review #38) ([#38](https://github.com/escouade/spine/issues/38))
- **throttle:** close policies-entry, routeId & proto-chain gaps in meta guard (PR #40 self-review) ([#40](https://github.com/escouade/spine/issues/40))
- **throttle:** harden override proto-chain on the enforcement path + cover it (round-2 review) ([127aec6](https://github.com/escouade/spine/commit/127aec6))

### ⚠️  Breaking Changes

- **gateway:** `ThrottleModule.configure({ routes })` and the exported ([e2692b5](https://github.com/escouade/spine/commit/e2692b5))

  `RouteSnapshot`/`RouteSnapshotSource` types are removed (0.x, no known consumers).
  Wire `throttleMetaValidatorRef()` into the gateway's `metaValidators` instead.
  - ADR 0023; docs EN+FR (throttle page + gateway/interceptors MetaValidator section)
  - connect-safety boot-assert (a request-scoped interceptor exposing interceptConnect)
    stays a separate follow-up, out of scope here
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
- **gateway:** `HttpGatewayModule.configure({ connectInterceptors })` is removed ([ae8dd2d](https://github.com/escouade/spine/commit/ae8dd2d))

  (0.x, zero known consumers). Wire the interceptor once in `interceptors`; it runs
  at connect iff it implements `ConnectInterceptor`.
  - gateway-core: export `ConnectInterceptor`, kept separate from `GatewayInterceptor`
    so the shared cross-transport port stays one method (future phases add their own
    markers)
  - http-gateway: derive + memoize the connect chain via a
    `typeof interceptConnect === "function"` filter; invoke it on the instance
    (this-safe); drop the `connectInterceptors` slot
  - throttle: `ThrottleInterceptor implements GatewayInterceptor, ConnectInterceptor`,
    both delegating to a shared `gate()` (one engine, one store)
  - ADR 0022 (amends 0017 §3); docs EN+FR (interceptors + throttle SSE)
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>

### ❤️ Thank You

- Claude Fable 5
- Claude Opus 4.8 (1M context)
- Fabien Metais @metaisfabien

## 0.1.4 (2026-07-06)

### 🚀 Features

- **gateway-core:** envelope failure metadata seam (Story 1.1) ([6f41e9f](https://github.com/escouade/spine/commit/6f41e9f))
- **http-gateway:** per-request response-headers bag (Story 1.2) ([48c9ed2](https://github.com/escouade/spine/commit/48c9ed2))
- **mikro-orm:** pure-fn create migration handler (Story 2.1) ([355b9fe](https://github.com/escouade/spine/commit/355b9fe))
- **mikro-orm:** pure-fn up/down/list/pending handlers (Story 2.2) ([e89dcf3](https://github.com/escouade/spine/commit/e89dcf3))
- **mikro-orm:** pure-fn parseArgv command/flag parser (Story 2.3) ([3095eef](https://github.com/escouade/spine/commit/3095eef))
- **mikro-orm:** injectable MigrationRunner with per-connection logging (Story 2.4) ([86062d4](https://github.com/escouade/spine/commit/86062d4))
- **mikro-orm:** headless runMigrations composition-root + command module (Story 2.5) ([9e5a916](https://github.com/escouade/spine/commit/9e5a916))
- **mikro-orm:** spine-migrate bin mapping the result to an exit code (Story 2.6) ([0a371bf](https://github.com/escouade/spine/commit/0a371bf))
- **mikro-orm:** migration:fresh — dev-only reset with --force-drop (Story 3.1) ([3f858c3](https://github.com/escouade/spine/commit/3f858c3))
- **mikro-orm:** migrateOnStart — dev-only guarded boot-run (Story 3.2) ([f856976](https://github.com/escouade/spine/commit/f856976))
- **openapi:** document SSE routes as event streams (Story 1.6) ([61ced1b](https://github.com/escouade/spine/commit/61ced1b))
- **openapi:** guard-derived security (Story 1.7) ([aeaf256](https://github.com/escouade/spine/commit/aeaf256))
- **openapi:** file-emit helper for JSON + YAML (Story 2.1) ([026c22e](https://github.com/escouade/spine/commit/026c22e))
- **throttle:** package scaffold, module and boot validation (Story 1.3) ([c6efb44](https://github.com/escouade/spine/commit/c6efb44))
- **throttle:** sliding-log memory store with injectable clock (Story 1.4) ([55c558b](https://github.com/escouade/spine/commit/55c558b))
- **throttle:** key pipeline, per-policy bounds and introspection (Story 1.5) ([963ced2](https://github.com/escouade/spine/commit/963ced2))
- **throttle:** store contract kit under ./testing (Story 1.6) ([9c8a650](https://github.com/escouade/spine/commit/9c8a650))
- **throttle:** engine and gateway interceptor (Story 1.7) ([e703184](https://github.com/escouade/spine/commit/e703184))
- **throttle:** ./http preset — 'ip' source and header translation (Story 1.9) ([38e9aab](https://github.com/escouade/spine/commit/38e9aab))
- **throttle:** IPC route options (handle() + meta.throttle) (Story 2.1) ([91cf128](https://github.com/escouade/spine/commit/91cf128))
- **throttle:** route snapshots + boot walk of inline specs (Story 2.2) ([9855e29](https://github.com/escouade/spine/commit/9855e29))
- **throttle:** SSE connect enforcement (connectInterceptors) (Story 2.3) ([4cdf86d](https://github.com/escouade/spine/commit/4cdf86d))
- **throttle,http-gateway:** HTTP route options via meta.throttle (Story 1.8) ([e38e80c](https://github.com/escouade/spine/commit/e38e80c))

### 🩹 Fixes

- **http-gateway:** case-insensitive header merge + reject non-object throttle meta (review PR #36) ([#36](https://github.com/escouade/spine/issues/36))
- **mikro-orm:** sync yarn.lock with spine-migrate bin entry ([a8f309c](https://github.com/escouade/spine/commit/a8f309c))
- **openapi:** order-insensitive security scheme conflict compare (review PR #32) ([#32](https://github.com/escouade/spine/issues/32))
- **openapi:** sync YAML golden with the FailureMeta seam ([1b5469f](https://github.com/escouade/spine/commit/1b5469f))
- **throttle:** override validation, scope guards + engine/store robustness (review PR #36) ([#36](https://github.com/escouade/spine/issues/36))
- **throttle:** trustProxy hardening + preset reads outcome slot, headers on by default (review PR #36) ([#36](https://github.com/escouade/spine/issues/36))

### ❤️ Thank You

- Claude Fable 5
- Claude Opus 4.8 (1M context)
- Fabien Metais @metaisfabien

## 0.1.3 (2026-07-06)

### 🚀 Features

- **core:** warn at boot when duplicate @spinejs/core copies are loaded ([3006c9b](https://github.com/escouade/spine/commit/3006c9b))
- **mikro-orm:** migrations config block + Spine defaults (Story 1.1) ([edaff63](https://github.com/escouade/spine/commit/edaff63))
- **mikro-orm:** register Migrator extension, peer/optional dependency (Story 1.2) ([ccad8c4](https://github.com/escouade/spine/commit/ccad8c4))
- **mikro-orm:** per-connection migration isolation + fail-closed collision guard (Story 1.3) ([ae44347](https://github.com/escouade/spine/commit/ae44347))
- **openapi:** response envelope + multi-status (Story 1.5) ([52ac852](https://github.com/escouade/spine/commit/52ac852))

### 🩹 Fixes

- **gateway:** catch zod v4 errors in ZodValidator ([af64a4c](https://github.com/escouade/spine/commit/af64a4c))

### ❤️ Thank You

- Claude Fable 5
- Claude Opus 4.8 (1M context)
- Fabien Metais @metaisfabien

## 0.1.2 (2026-07-05)

### 🚀 Features

- **examples:** request-scoped unit-of-work example for @spinejs/mikro-orm ([931e438](https://github.com/escouade/spine/commit/931e438))
- **gateway,openapi:** foundation seams for the OpenAPI battery ([f780b6d](https://github.com/escouade/spine/commit/f780b6d))
- **mikro-orm:** request-scoped MikroORM integration [stories 1.1-1.3] ([458bdeb](https://github.com/escouade/spine/commit/458bdeb))
- **mikro-orm:** repositories, logging bridge, integration tests [stories 1.4-1.6] ([80cb155](https://github.com/escouade/spine/commit/80cb155))
- **mikro-orm:** asInterceptor() helper for a transport's typed slot ([58a10bc](https://github.com/escouade/spine/commit/58a10bc))
- **mikro-orm:** named multi-connection support (ADR 0016 Amendment 1) ([bbe5825](https://github.com/escouade/spine/commit/bbe5825))
- **openapi:** scaffold @spinejs/openapi + ZodSchemaConverter (Story 1.2) ([4a4b60c](https://github.com/escouade/spine/commit/4a4b60c))
- **openapi:** pure builder — operations, parameters, metadata (Story 1.3) ([031087b](https://github.com/escouade/spine/commit/031087b))
- **openapi:** component registry + $ref strategy (Story 1.4) ([8684551](https://github.com/escouade/spine/commit/8684551))
- **scheduler,http-gateway:** SSE fan-out + CLS-scoped scheduling batteries ([46e5ede](https://github.com/escouade/spine/commit/46e5ede))

### 🩹 Fixes

- **mikro-orm:** rollback-on-error, module isolation, retry guard, log levels ([#11](https://github.com/escouade/spine/issues/11))
- **mikro-orm:** BMAD review — lazy-flush UoW + logger/onStop/retry/repo hardening ([#11](https://github.com/escouade/spine/issues/11))
- **mikro-orm:** actionable CLS-scope diagnostic + document limitations ([f729b3a](https://github.com/escouade/spine/commit/f729b3a))
- **mikro-orm:** address multi-connection code-review findings (PR #20 follow-up) ([#20](https://github.com/escouade/spine/issues/20))
- **openapi:** resolve cyclic $ref and lock $defs names (review PR #25) ([#25](https://github.com/escouade/spine/issues/25))
- **release:** register openapi + scheduler in root workspaces ([f0b96fa](https://github.com/escouade/spine/commit/f0b96fa))
- **scheduler,http-gateway:** address code-review findings (13 patches) ([c2a4e31](https://github.com/escouade/spine/commit/c2a4e31))

### ❤️ Thank You

- Claude Fable 5
- Claude Opus 4.8
- Claude Opus 4.8 (1M context)
- Fabien Metais @metaisfabien

## 0.1.1 (2026-07-04)

### 🩹 Fixes

- git ignore and claud settings ([d68703a](https://github.com/escouade/spine/commit/d68703a))
- **electron:** register activate listener once, secure window defaults, flush bounds on close ([038c886](https://github.com/escouade/spine/commit/038c886))
- **gateway-core:** map interceptor errors to envelopes, never throw from dispatch ([4178dd1](https://github.com/escouade/spine/commit/4178dd1))
- **release:** resolve workspace deps to built d.ts in dts pass ([b71c8c0](https://github.com/escouade/spine/commit/b71c8c0))
- **release:** drop --yes from the skip-publish nx release step ([1bb0fca](https://github.com/escouade/spine/commit/1bb0fca))

### ❤️ Thank You

- Claude Fable 5
- Claude Opus 4.8 (1M context)
- Fabien Metais @metaisfabien