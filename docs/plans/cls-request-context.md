# Implementation plan — `@spinejs/cls` (per-request ambient context)

> Self-contained plan for implementing [ADR 0003](../adr/0003-cls-request-context.md). Follow the
> steps in order. All file contents are given verbatim — copy them exactly. Run the verification at
> the end before opening the PR.

## 0. Ground rules (read first)

- **Goal**: a new package `@spinejs/cls` (an `AsyncLocalStorage` wrapper exposed as an injectable
  singleton `ClsService` + a `ClsModule`), plus a runnable example wiring it into the electron IPC
  gateway through the gateway's **existing** interceptor hook. **Do not modify `packages/core` or
  `packages/gateway`.**
- **Git flow (from `CLAUDE.md`)**: never commit to `main`. Create one fresh, uniquely-named branch.
  Integrate only via squash PR. **Do not run `git reset --hard`** — this plan and the ADR are
  uncommitted in the working tree and a hard reset would delete them.
- **Do NOT stage these unrelated, pre-existing working-tree edits** (they are the user's, not part of
  this work): `.claude/settings.json` and `packages/core/src/app.ts`. Stage only the files you create
  plus `docs/adr/0003-cls-request-context.md`, `docs/plans/cls-request-context.md`, the docs, and the
  root `package.json` workspaces change.
- **Decorators**: the `@spinejs/cls` package uses only the `@Module` **class** decorator → it works
  under the repo's default (stage-3) decorators, so its `tsconfig.json` must **not** set
  `experimentalDecorators`. The example uses `@Handler` (a **method** decorator written legacy-style)
  → its `tsconfig.json` **must** set `"experimentalDecorators": true`, or routes silently fail to
  register. (Known framework gap: `@Handler` is not stage-3 compatible. Out of scope here.)
- After every milestone run the repo checks (see step 6). CI requires them green.

---

## 1. Create the `@spinejs/cls` package

Create these files under `packages/cls/`.

### `packages/cls/package.json`

```json
{
  "name": "@spinejs/cls",
  "version": "0.0.1",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts",
  "dependencies": {
    "@spinejs/core": "workspace:*"
  }
}
```

### `packages/cls/project.json`

```json
{
  "name": "cls",
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "packages/cls/src",
  "projectType": "library",
  "tags": [],
  "targets": {
    "typecheck": {
      "executor": "nx:run-commands",
      "options": {
        "command": "tsc -p tsconfig.json --noEmit",
        "cwd": "{projectRoot}"
      }
    },
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "vitest run --passWithNoTests",
        "cwd": "{projectRoot}"
      }
    }
  }
}
```

### `packages/cls/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "es2022",
    "lib": ["es2023"],
    "types": ["node"],
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "src/**/*.spec.ts", "src/**/*.test.ts"]
}
```

### `packages/cls/vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.spec.ts"],
  },
});
```

### `packages/cls/src/cls.service.ts`

```ts
import { AsyncLocalStorage } from "node:async_hooks";

/** A per-scope key→value store. Apps narrow it with their own keys. */
export type ClsStore = Record<string, unknown>;

/**
 * Continuation-Local Storage: the single owner of one `AsyncLocalStorage`, exposed as an injectable
 * singleton. `run()` opens a scope (one per request / dispatch / job); any code in that async call
 * chain reads and writes the same store through `get`/`set`, with nothing threaded through the
 * signatures. Two concurrent `run()`s get isolated stores — the binding is to the async execution
 * context, not to an instance — so the singleton stays shared while the data stays per-scope.
 *
 * Centralise the `AsyncLocalStorage` here: never instantiate one elsewhere. Consumers depend on this
 * service (or a typed wrapper over it), keeping the ambient access in one place.
 */
export class ClsService {
  private readonly als = new AsyncLocalStorage<ClsStore>();

  /** Opens a fresh scope seeded with a copy of `seed`, runs `fn` inside it, returns its result. */
  run<R>(seed: ClsStore, fn: () => R): R {
    return this.als.run({ ...seed }, fn);
  }

  /** True when called inside an active `run()` scope. */
  get active(): boolean {
    return this.als.getStore() !== undefined;
  }

  /** Reads a key from the active scope; `undefined` if absent or called outside any scope. */
  get<T>(key: string): T | undefined {
    return this.als.getStore()?.[key] as T | undefined;
  }

  /** Writes a key into the active scope. Throws outside a scope — there is nothing to write to. */
  set<T>(key: string, value: T): void {
    const store = this.als.getStore();
    if (!store) {
      throw new Error(
        `ClsService.set("${key}") called outside an active scope. Open one with run().`
      );
    }
    store[key] = value;
  }

  /** True when `key` exists in the active scope. */
  has(key: string): boolean {
    const store = this.als.getStore();
    return store !== undefined && key in store;
  }
}
```

### `packages/cls/src/cls.module.ts`

```ts
import { Module } from "@spinejs/core";
import { ClsService } from "./cls.service";

/**
 * Provides `ClsService` as a shared singleton and exports it. Import it once in the module graph;
 * any module that imports it can then inject `ClsService`. Opening a scope per request is the
 * caller's job (e.g. a gateway interceptor calling `cls.run()`), which keeps this module
 * transport-agnostic — it knows nothing about gateways, HTTP, or "requests".
 */
@Module({
  providers: [ClsService],
  exports: [ClsService],
})
export class ClsModule {}
```

### `packages/cls/src/index.ts`

```ts
// @spinejs/cls public API: continuation-local storage as an injectable singleton.
export { ClsService } from "./cls.service";
export type { ClsStore } from "./cls.service";
export { ClsModule } from "./cls.module";
```

### `packages/cls/src/cls.service.spec.ts`

```ts
import { ClsService } from "./cls.service";

describe("ClsService", () => {
  it("reads and writes within an active scope", () => {
    const cls = new ClsService();
    cls.run({ user: "alice" }, () => {
      expect(cls.get<string>("user")).toBe("alice");
      cls.set("reqId", "r-1");
      expect(cls.get<string>("reqId")).toBe("r-1");
      expect(cls.has("user")).toBe(true);
      expect(cls.has("missing")).toBe(false);
    });
  });

  it("reports whether a scope is active", () => {
    const cls = new ClsService();
    expect(cls.active).toBe(false);
    cls.run({}, () => expect(cls.active).toBe(true));
    expect(cls.active).toBe(false);
  });

  it("returns undefined and throws outside a scope", () => {
    const cls = new ClsService();
    expect(cls.get("user")).toBeUndefined();
    expect(() => cls.set("user", "x")).toThrow(/outside an active scope/);
  });

  it("does not leak writes back into the seed object", () => {
    const cls = new ClsService();
    const seed = { user: "alice" };
    cls.run(seed, () => cls.set("reqId", "r-1"));
    expect(seed).toEqual({ user: "alice" }); // seed was cloned
  });

  it("isolates concurrent scopes (the core guarantee)", async () => {
    const cls = new ClsService();
    const readBack = (user: string) =>
      cls.run({ user }, async () => {
        await new Promise((r) => setTimeout(r, 5)); // force interleaving
        return cls.get<string>("user");
      });
    const [a, b] = await Promise.all([readBack("alice"), readBack("bob")]);
    expect(a).toBe("alice");
    expect(b).toBe("bob");
  });
});
```

### `packages/cls/README.md`

```md
# @spinejs/cls

Continuation-local storage for SpineJS: a single `AsyncLocalStorage` exposed as an injectable
singleton `ClsService`, plus `ClsModule`. Open a scope per request (e.g. from a gateway interceptor
calling `cls.run()`); deep services read the current request's data via `cls.get()` without threading
a context object. See [ADR 0003](../../docs/adr/0003-cls-request-context.md).
```

---

## 2. Register the package in the workspace

A new package needs a `node_modules/@spinejs/cls` symlink, created by `yarn install`.

1. Edit the root `package.json` `workspaces` array — add `"packages/cls"` (keep it next to the other
   `packages/*` entries):

   ```json
   "workspaces": [
     "packages/core",
     "packages/gateway",
     "packages/cls",
     "packages/config",
     "packages/winston-logger",
     "packages/electron",
     "packages/electron-ipc-gateway",
     "apps/docs-site"
   ],
   ```

2. Run `yarn install` (creates the symlink; should not pull anything new from the network — only
   workspace deps). Confirm `node_modules/@spinejs/cls` now exists.

3. Verify the package alone: `npx nx test cls` and `npx nx typecheck cls` — both green.

---

## 3. Create the example app

Create `examples/cls-request-context/`. It boots a real `ElectronIpcGateway` headlessly (mocking
`electron`) and proves: a deep singleton `AuditService` reads the correct per-request user via CLS,
under concurrency, while staying a singleton.

### `examples/cls-request-context/package.json`

```json
{
  "name": "@spinejs-examples/cls-request-context",
  "version": "0.0.0",
  "private": true,
  "main": "src/main.ts",
  "types": "src/main.ts",
  "dependencies": {
    "@spinejs/core": "workspace:*",
    "@spinejs/gateway-core": "workspace:*",
    "@spinejs/electron-ipc-gateway": "workspace:*",
    "@spinejs/cls": "workspace:*"
  }
}
```

> Note: the example is **not** added to the root `workspaces` (mirrors how the repo keeps examples
> out of the published set). It still resolves `@spinejs/*` via the root `node_modules` symlinks, and
> nx discovers it via its `project.json`.

### `examples/cls-request-context/project.json`

```json
{
  "name": "example-cls-request-context",
  "$schema": "../../node_modules/nx/schemas/project-schema.json",
  "sourceRoot": "examples/cls-request-context/src",
  "projectType": "application",
  "tags": [],
  "targets": {
    "typecheck": {
      "executor": "nx:run-commands",
      "options": {
        "command": "tsc -p tsconfig.json --noEmit",
        "cwd": "{projectRoot}"
      }
    },
    "test": {
      "executor": "nx:run-commands",
      "options": {
        "command": "vitest run --passWithNoTests",
        "cwd": "{projectRoot}"
      }
    }
  }
}
```

### `examples/cls-request-context/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "target": "es2022",
    "lib": ["es2023"],
    "types": ["node"],
    "experimentalDecorators": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "src/**/*.spec.ts", "src/**/*.test.ts"]
}
```

### `examples/cls-request-context/vitest.config.ts`

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.spec.ts"],
  },
});
```

### `examples/cls-request-context/src/app-context.ts`

```ts
import type {
  ElectronIpcBaseContext,
  ElectronIpcRaw,
} from "@spinejs/electron-ipc-gateway";
import type { ContextFactory, ErrorMapper } from "@spinejs/gateway-core";

/**
 * The app's dispatch context: the transport's base context (the electron event) plus the caller's
 * identity, read from the IPC payload. The CLS interceptor seeds the request scope from this.
 */
export interface AppContext extends ElectronIpcBaseContext {
  user: string;
}

/** Builds one `AppContext` per IPC call, taking `user` from the payload (defaults to anonymous). */
export class AppContextFactory
  implements ContextFactory<ElectronIpcRaw, AppContext>
{
  create(raw: ElectronIpcRaw): AppContext {
    const [payload] = raw.args as [{ user?: string } | undefined];
    return { event: raw.event, user: payload?.user ?? "anonymous" };
  }
}

/** Minimal error mapper: turns any thrown error into its class name as a stable code. */
export class AppErrorMapper implements ErrorMapper<string> {
  toCode(err: unknown): string {
    return err instanceof Error ? err.name : "UNKNOWN";
  }
}
```

### `examples/cls-request-context/src/cls.interceptor.ts`

```ts
import { randomUUID } from "node:crypto";
import { ClsService } from "@spinejs/cls";
import type {
  Envelope,
  GatewayInterceptor,
  RouteDescriptor,
} from "@spinejs/gateway-core";
import type { AppContext } from "./app-context";

/**
 * Opens a CLS scope per dispatch, seeded from the context. `cls.run(seed, next)` IS the per-request
 * boundary: everything inside `next()` (guards, handler, the whole service graph) reads this store.
 * The seed maps the dispatch context to the store, so this glue is app-specific.
 */
export class ClsInterceptor implements GatewayInterceptor<AppContext> {
  constructor(private readonly cls: ClsService) {}

  intercept(
    _route: RouteDescriptor<AppContext>,
    ctx: AppContext,
    _rawInput: unknown,
    next: () => Promise<Envelope<unknown>>
  ): Promise<Envelope<unknown>> {
    return this.cls.run({ user: ctx.user, reqId: randomUUID() }, next);
  }
}
```

### `examples/cls-request-context/src/audit.service.ts`

```ts
import { Injectable } from "@spinejs/core";
import { ClsService } from "@spinejs/cls";

/**
 * A deep singleton with NO `ctx` parameter. It reads the current request's data straight from the
 * CLS store, so it sees the right user even though it is shared across all concurrent requests.
 */
@Injectable({ inject: [ClsService] })
export class AuditService {
  constructor(private readonly cls: ClsService) {}

  currentUser(): string {
    return this.cls.get<string>("user") ?? "anonymous";
  }

  currentReqId(): string {
    return this.cls.get<string>("reqId") ?? "none";
  }
}
```

### `examples/cls-request-context/src/whoami.controller.ts`

```ts
import { Injectable } from "@spinejs/core";
import { Controller, Handler } from "@spinejs/gateway-core";
import { AuditService } from "./audit.service";
import type { AppContext } from "./app-context";

/** Shape returned by the `whoami` handler. */
export interface WhoAmIResult {
  user: string;
  reqId: string;
}

/**
 * A singleton controller that never touches `ctx` for identity. It delegates to the singleton
 * `AuditService`, which reads the per-request user from CLS. The `await` forces interleaving so the
 * test exercises concurrent scopes.
 */
@Controller()
@Injectable({ inject: [AuditService] })
export class WhoAmIController {
  constructor(private readonly audit: AuditService) {}

  @Handler({ address: "whoami" })
  async whoami(_ctx: AppContext): Promise<WhoAmIResult> {
    await new Promise((r) => setTimeout(r, 5));
    return { user: this.audit.currentUser(), reqId: this.audit.currentReqId() };
  }
}
```

### `examples/cls-request-context/src/app.module.ts`

```ts
import type { ModuleEntry } from "@spinejs/core";
import { ClsModule, ClsService } from "@spinejs/cls";
import {
  ElectronIpcGatewayModule,
  ipcFeature,
} from "@spinejs/electron-ipc-gateway";
import { AppContextFactory, AppErrorMapper } from "./app-context";
import { ClsInterceptor } from "./cls.interceptor";
import { AuditService } from "./audit.service";
import { WhoAmIController } from "./whoami.controller";

/**
 * Wiring. `ClsModule` is imported in BOTH the transport module (for the interceptor) and the feature
 * module (for `AuditService`). Because `ClsModule` is a single (non-`fresh`) module, both imports
 * share the same `ClsService` instance — the interceptor's `run()` and the service's `get()` use the
 * same `AsyncLocalStorage`, which is essential.
 */
export const modules: ModuleEntry[] = [
  ElectronIpcGatewayModule.configure({
    imports: [ClsModule],
    contextFactory: { value: new AppContextFactory() },
    errorMapper: { value: new AppErrorMapper() },
    interceptors: {
      inject: [ClsService],
      factory: (cls: ClsService) => [new ClsInterceptor(cls)],
    },
  }),
  ipcFeature({
    controllers: [WhoAmIController],
    providers: [AuditService],
    imports: [ClsModule],
  }),
];
```

### `examples/cls-request-context/src/main.ts`

```ts
import { App, Logger } from "@spinejs/core";
import { modules } from "./app.module";

/** Boots the example App. Reused by the spec (which mocks `electron` to drive dispatches). */
export function createApp(options?: { logger?: Logger }): App {
  return new App(modules, {
    logger: options?.logger,
    handleProcessExit: false,
  });
}
```

### `examples/cls-request-context/src/cls-request-context.spec.ts`

```ts
import { vi } from "vitest";
import type { Logger } from "@spinejs/core";

/**
 * Headless run: `electron` is mocked so the real `ElectronIpcGateway` binds its routes on a fake
 * `ipcMain`, and we replay IPC invokes by calling the captured listeners.
 */
const { ipcRegistry } = vi.hoisted(() => ({
  ipcRegistry: new Map<
    string,
    (event: unknown, ...args: unknown[]) => Promise<unknown>
  >(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: (
      channel: string,
      listener: (event: unknown, ...args: unknown[]) => Promise<unknown>
    ) => ipcRegistry.set(channel, listener),
  },
}));

// Imported after the mock so the gateway picks up the fake ipcMain.
import { App } from "@spinejs/core";
import { createApp } from "./main";
import type { WhoAmIResult } from "./whoami.controller";

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;

/** Simulates `ipcRenderer.invoke(channel, payload)`, unwrapping the envelope. */
async function invoke<T>(channel: string, payload: unknown): Promise<T> {
  const listener = ipcRegistry.get(channel);
  if (!listener) throw new Error(`No IPC handler registered for "${channel}".`);
  const envelope = (await listener({}, payload)) as
    | { ok: true; data: T }
    | { ok: false; code: string };
  if (!envelope.ok)
    throw new Error(`Dispatch "${channel}" failed: ${envelope.code}`);
  return envelope.data;
}

describe("CLS request context over the electron IPC gateway", () => {
  let app: App;

  beforeAll(async () => {
    app = createApp({ logger: silentLogger });
    await app.init(); // registers the "whoami" route on the fake ipcMain
  });

  afterAll(async () => {
    await app.stop();
  });

  it("gives each concurrent dispatch the right user via a shared singleton", async () => {
    const [alice, bob] = await Promise.all([
      invoke<WhoAmIResult>("whoami", { user: "alice" }),
      invoke<WhoAmIResult>("whoami", { user: "bob" }),
    ]);

    // The singleton AuditService saw the correct per-request user in each concurrent scope.
    expect(alice.user).toBe("alice");
    expect(bob.user).toBe("bob");

    // Each dispatch got its own reqId.
    expect(alice.reqId).not.toBe(bob.reqId);
  });

  it("defaults to anonymous when no user is supplied", async () => {
    const result = await invoke<WhoAmIResult>("whoami", {});
    expect(result.user).toBe("anonymous");
  });
});
```

### `examples/cls-request-context/README.md`

```md
# Example — CLS request context over the electron IPC gateway

Proof of concept for [ADR 0003](../../docs/adr/0003-cls-request-context.md): per-request ambient data
via `@spinejs/cls`, without DI request scope and without threading `ctx` through every service.

- A `ClsInterceptor` opens a CLS scope per dispatch (`cls.run`), seeded from the context.
- The singleton `AuditService` reads `cls.get("user")` — no `ctx` parameter — and still sees the
  right user per request, even under concurrency, because `AsyncLocalStorage` isolates by async
  context, not by instance.
- `@spinejs/core` and `@spinejs/gateway-core` are untouched: the scope rides the gateway's existing
  interceptor hook.

## Run

`electron` is mocked, so the real `ElectronIpcGateway` runs without an Electron process:

\`\`\`bash
npx nx test example-cls-request-context
\`\`\`

The spec fires two concurrent `whoami` invokes (alice + bob) and asserts each sees its own user.
```

> In the README above, replace the `\`\`\`` fences with real triple-backtick fences (they are escaped
> here only to keep this plan a valid code block).

---

## 4. Documentation (EN + FR) — required by `CLAUDE.md`

A new public package is a public-interface change, so add a Docusaurus page in **both** languages and
register it in the sidebar.

### 4a. `apps/docs-site/docs/extensions/cls.md` (English)

```md
---
sidebar_position: 3
---

# CLS (request context)

`@spinejs/cls` provides per-request ambient state via Node's `AsyncLocalStorage`, exposed as an
injectable singleton `ClsService`. Use it to make request data (the authenticated user, a correlation
id, the current tenant) available deep in a service graph **without threading a context object**
through every method — and without the cost of a DI request scope (no per-request re-instantiation).

See [ADR 0003](https://github.com/dev-studio-ai/spine/blob/main/docs/adr/0003-cls-request-context.md)
for the rationale.

## Installation

`ClsModule` is a standard SpineJS module. Import it wherever you inject `ClsService`:

\`\`\`typescript
import { Module } from "@spinejs/core";
import { ClsModule } from "@spinejs/cls";

@Module({ imports: [ClsModule] })
export class SomeFeatureModule {}
\`\`\`

`ClsModule` provides a single shared `ClsService`. Import it in several modules freely — they all see
the same instance, which is required so the code that opens a scope and the code that reads it share
one `AsyncLocalStorage`.

## API

`ClsService`:

- `run<R>(seed, fn): R` — opens a scope seeded with a copy of `seed`, runs `fn` inside it.
- `get active(): boolean` — whether a scope is currently active.
- `get<T>(key): T | undefined` — read the active scope (`undefined` outside any scope).
- `set<T>(key, value): void` — write the active scope (throws outside a scope).
- `has(key): boolean` — whether the key exists in the active scope.

## Opening a scope per request

`ClsService.run()` is the per-request boundary. With the gateway, open it from an interceptor — the
gateway core is not touched:

\`\`\`typescript
import { randomUUID } from "node:crypto";
import { ClsService } from "@spinejs/cls";
import type { GatewayInterceptor } from "@spinejs/gateway-core";

export class ClsInterceptor implements GatewayInterceptor<AppContext> {
constructor(private readonly cls: ClsService) {}
intercept(\_route, ctx, \_input, next) {
return this.cls.run({ user: ctx.user, reqId: randomUUID() }, next);
}
}
\`\`\`

Register it via your transport's `configure({ interceptors })`.

## Reading the context

Inject `ClsService` (or a typed wrapper) into any singleton service — no `ctx` parameter:

\`\`\`typescript
import { Injectable } from "@spinejs/core";
import { ClsService } from "@spinejs/cls";

@Injectable({ inject: [ClsService] })
export class AuditService {
constructor(private readonly cls: ClsService) {}
log(action: string) {
const user = this.cls.get<string>("user");
// ...
}
}
\`\`\`

## Concurrency

`AsyncLocalStorage` binds the store to the async execution context, not to an instance. Two
concurrent requests get isolated stores, so the same singleton returns each request's own value.

## Guidance

- Centralise the `AsyncLocalStorage` in `ClsService` — never instantiate one elsewhere.
- For shallow needs (a handler reading `ctx.user` directly), just use the context; CLS earns its keep
  when a deep service graph would otherwise thread `ctx` everywhere.
- Calling `get` outside a scope returns `undefined`; `set` throws. Make sure every entry point that
  needs the context opens one with `run()`.

A full runnable example lives in `examples/cls-request-context`.
```

> Replace the escaped `\`\`\`` fences with real triple backticks.

### 4b. `apps/docs-site/i18n/fr/docusaurus-plugin-content-docs/current/extensions/cls.md` (French)

Same structure, translated. Frontmatter identical (`sidebar_position: 3`). Translate the prose to
French (mirror the tone of the existing `extensions/config.md` FR mirror); keep all code blocks,
identifiers, and the ADR link **unchanged**. Title: `# CLS (contexte de requête)`.

### 4c. Sidebar

In `apps/docs-site/sidebars.ts`, add `"extensions/cls"` to the **Extensions** category items:

```ts
{
  type: "category",
  label: "Extensions",
  items: ["extensions/config", "extensions/winston-logger", "extensions/cls"],
},
```

### 4d. Cross-link from the DI doc (EN + FR)

In the "Provider scopes" / "Portées de provider" section of
`apps/docs-site/docs/core/dependency-injection.md` and its FR mirror
(`apps/docs-site/i18n/fr/docusaurus-plugin-content-docs/current/core/dependency-injection.md`), add a
short note that per-request state is handled by CLS rather than a DI request scope, linking to the
new page. One sentence each, EN and FR. Example (EN):

> For per-request state (current user, correlation id), SpineJS does not add a DI "request" scope —
> use [CLS](../extensions/cls.md) instead, which keeps services as singletons.

---

## 5. Verification (must be green before the PR)

From the repo root:

```bash
yarn format:write
yarn lint:all
yarn typecheck:all
yarn test:all
yarn docs:build
```

All must pass. `lint`/`typecheck`/`test` now include `cls` and `example-cls-request-context`
(confirm with `npx nx show projects`). Expected example test output: 2 passing tests; expected cls
output: 5 passing tests.

---

## 6. Git & PR

```bash
git checkout -b feat/cls-request-context-2026-06-30
```

Stage **only** the work of this task — explicitly exclude the user's pre-existing edits:

```bash
git add packages/cls examples/cls-request-context \
        docs/adr/0003-cls-request-context.md docs/plans/cls-request-context.md \
        apps/docs-site/docs/extensions/cls.md \
        apps/docs-site/i18n/fr/docusaurus-plugin-content-docs/current/extensions/cls.md \
        apps/docs-site/sidebars.ts \
        apps/docs-site/docs/core/dependency-injection.md \
        apps/docs-site/i18n/fr/docusaurus-plugin-content-docs/current/core/dependency-injection.md \
        package.json
# Do NOT `git add` .claude/settings.json or packages/core/src/app.ts.
```

Confirm `git status` shows those two files still unstaged. Commit (end the message with the
co-author line):

```
feat(cls): add @spinejs/cls for per-request ambient context

Implements ADR 0003. A new @spinejs/cls package wraps AsyncLocalStorage in an
injectable singleton ClsService + ClsModule. The per-request scope is opened by
a gateway interceptor (existing hook) calling cls.run(); deep singletons read
the current request via cls.get() with no ctx threaded and no DI request scope.
core and gateway are untouched. Includes a runnable example and EN/FR docs.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
```

Push and open the PR (`gh pr create`), ending the body with the Claude Code generated line. If the
branch name is already taken, bump the date suffix.

---

## Acceptance checklist

- [ ] `packages/cls` created; `npx nx test cls` → 5 passing.
- [ ] Root `workspaces` updated; `yarn install` ran; `node_modules/@spinejs/cls` symlink exists.
- [ ] `examples/cls-request-context` created; `npx nx test example-cls-request-context` → 2 passing.
- [ ] `core` and `gateway` packages unchanged (`git diff --stat` shows nothing under
      `packages/core` or `packages/gateway`).
- [ ] Docs added EN + FR, sidebar updated, `yarn docs:build` green.
- [ ] `yarn lint:all && yarn typecheck:all && yarn test:all` all green.
- [ ] `.claude/settings.json` and `packages/core/src/app.ts` are NOT in the commit.
- [ ] PR opened from a fresh branch.

```

```
