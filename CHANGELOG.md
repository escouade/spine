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