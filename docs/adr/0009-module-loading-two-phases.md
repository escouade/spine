# ADR 0009 — Module loading in two phases: build → detect cycles → resolve

- **Status**: Accepted
- **Date**: 2026-07-02
- **Scope**: `packages/core` (`module/module-loader.ts`)
- **Relation**: feeds into [ADR 0010](./0010-atomic-module-lifecycle.md) (lifecycle) and [ADR 0012](./0012-silent-duplicate-provider-registration.md) (first-registration-wins depends on the full provider set being known upfront).

## Context

`ModuleLoader.load()` turns a declarative module graph (`@Module` classes, `DynamicModule` objects from `configure()`) into live, initialized instances. Two things make this non-trivial:

- A `DynamicModule` can be imported from multiple places, each occurrence potentially adding its own extra `providers`/`imports`/`exports` on top of the base class. The complete provider set for a given module identity is only known once every occurrence in the graph has been visited.
- The graph can contain accidental cycles (module A imports B imports A), which must be caught **before** any module is instantiated — an async instantiation-time cycle check risks deadlocking on unresolved promises instead of failing cleanly.

## Decision

`load()` runs three steps, strictly in order:

```ts
async load(): Promise<Map<object, ModuleRef>> {
  this.buildNodes();
  this.detectCycles();
  await this.resolveModules();
  return this.resolvedModules;
}
```

### 1. `buildNodes()` — synchronous, no container touched

Walks every root entry and its imports, building one `ModuleNode` per module identity (the class, or the `DynamicModule` object itself when `fresh: true`). Every occurrence of the same identity is visited and merged (`addProviders`/`addImports`/`addExports`), even if the walk already recursed into that identity once — so a `DynamicModule`'s extra providers accumulate regardless of which import site introduced them first.

### 2. `detectCycles()` — static DFS on the finished graph

Classic three-color DFS (white/gray/black) over the `nodes` map built in phase 1. A back-edge to a gray node is a cycle, reported with the full module path. This runs entirely on the static graph — no container, no async — so it's independent of resolution order or memoization and can't itself deadlock.

### 3. `resolveModules()` — async instantiation + `onInit()`

Only after 1 and 2 succeed does actual instantiation begin: build each module (`new ModuleConstructor(...)`), wire imports' exported tokens into the importer's container, then run `onInit()`. Because the graph is already known to be a DAG, resolution can safely recurse through imports without a runtime cycle guard.

**Why the split matters**: [ADR 0012](./0012-silent-duplicate-provider-registration.md) makes the _first_ registration of a token in a container win. If instantiation (phase 3) started before a module's full provider set was known (i.e. without phase 1 running to completion first), an importer could register a partial/stale version of a re-exported token before a later-processed `DynamicModule` occurrence had contributed its extra providers — a registration-order bug that would depend on unrelated import ordering. Splitting the phases guarantees every module's complete provider set is known before any container registration happens.

## Alternatives considered

### Single-pass, lazy/on-demand module resolution (resolve as encountered, no upfront build)

Rejected: cycle detection would have to happen during instantiation, where a cycle looks the same as "still resolving" (an in-flight promise) — indistinguishable from a legitimate diamond-shaped import without extra bookkeeping, and any registration-order dependency on `DynamicModule` merging (above) would resurface.

### Detect cycles during phase 3 instead of a dedicated phase 2

Rejected: instantiation is async (imports resolved via `Promise.all`, `onInit()` awaited); a cycle would manifest as a hang (two modules each awaiting the other's resolution promise) rather than a clean thrown error with a resolvable path to report.

## Consequences

- **Positive**: cycle errors are reported with a full, accurate module path, independent of resolution/import order.
- **Positive**: `DynamicModule` provider/import/export accumulation is complete before any container sees a token — no ordering-dependent partial registration.
- **Positive**: phase 3 can assume a DAG and skip runtime cycle bookkeeping entirely.
- **Negative**: two full graph traversals before any instantiation starts (build, then cycle-check) — a cost paid even for graphs with no dynamic modules or cycles, though negligible relative to actual `onInit()` work.
