# ADR 0006 — Custom minimal DI container (no third-party library)

- **Status**: Accepted
- **Date**: 2026-07-02
- **Scope**: `packages/core` (`container/`)
- **Relation**: foundation for [ADR 0001](./0001-di-provider-scope.md) (scope), [ADR 0007](./0007-injection-token-symbol-identity.md) (token identity) and [ADR 0008](./0008-explicit-injection-no-reflect-metadata.md) (injection declaration).

## Context

Every module system needs dependency injection: resolve a class's dependencies, cache singletons, detect cycles, let a module export/re-export tokens to its importers. Mature libraries already solve this (NestJS's own DI, InversifyJS, tsyringe), each battle-tested and documented.

The framework instead ships its own `Container` (`container/container.ts`). The needs driving this are specific to how modules compose here:

- **Cross-module delegation without copying the resolved instance.** When module B imports module A and re-exposes one of A's exported tokens, B's container must resolve through to A's container and get the _exact same_ cached instance (singleton semantics preserved across container boundaries), not a fresh one. This "resolve in another container, alias here" mechanic (`delegate` / `existing` provider shapes) is not a mainstream DI library's default composition model — most assume a single container or an explicit parent/child hierarchy that doesn't map cleanly onto import/export module boundaries.
- **No `reflect-metadata` dependency** ([ADR 0008](./0008-explicit-injection-no-reflect-metadata.md)) — most established containers (InversifyJS, tsyringe, NestJS) are built around parameter-decorator + `reflect-metadata` type reflection. Dropping that requirement here means the resolution model (explicit `inject:` arrays, five provider shapes) doesn't map onto what those libraries expose.
- **Small, auditable surface.** `Container` is ~250 lines. The whole resolution algorithm (lazy `get`, cycle detection via a `parents` chain, five provider shapes) fits in one file and is easy to reason about end to end — a property that matters more here than in a typical app, since this is framework code other packages build on.

## Decision

`Container` is implemented from scratch in `packages/core/src/container/container.ts`, with:

### 1. Five provider shapes

```ts
export type Provider<T = unknown> =
  | BaseProvider<T> // { provide, inject?, scope? } — class provider
  | FactoryProvider<T> // + factory(...)
  | ValueProvider<T> // + value
  | DelegateProvider<T> // + delegate() — defers resolution to another container
  | ExistingProvider<T>; // + existing — pure alias to another token
```

`delegate` and `existing` are the two shapes that make cross-container composition possible: the module loader wires an importer's re-exported token as a `delegate` that calls back into the exporting module's own container (see [ADR 0009](./0009-module-loading-two-phases.md)).

### 2. Lazy resolution with singleton cache

```ts
private resolveToken<T = unknown>(token: Token, parents: Token[] = []): T {
  const key = tokenKey(token);
  if (this.resolved.has(key)) return this.resolved.get(key) as T;
  if (this.has(token)) {
    const resolved = this.resolve<T>(token, [...parents]);
    if (this.effectiveScope(token) !== "transient")
      this.resolved.set(key, resolved);
    return resolved;
  }
  if (this.parent) return this.parent.resolveToken<T>(token, parents);
  throw this.unknownProviderError(token, parents);
}
```

Nothing is instantiated until first `get()`. A provider not found locally falls through to `parent` (used for the global container).

### 3. Cycle detection at resolution time

`resolveDeps` threads a `parents: Token[]` chain through every recursive resolution; a token appearing twice in that chain throws `Circular dependency: ...` with the full chain rendered for the error message. A provider injecting itself is caught eagerly at `add()` time as a cheap special case.

### 4. `existing` goes through the same cycle-detection path as `inject`

```ts
if ("existing" in provider && provider.existing !== undefined) {
  return this.resolveDeps([provider.existing], parents)[0] as T;
}
```

An alias is resolved via `resolveDeps` (not a direct `resolveToken` call) so an alias cycle (`A existing B`, `B existing A`) is caught the same way a dependency cycle would be.

## Alternatives considered

### Adopt an existing DI library (InversifyJS, tsyringe, or NestJS's own container)

Rejected. All three assume either `reflect-metadata` parameter reflection or a container/binding API that doesn't map onto the module-scoped import/export/delegate model the loader needs ([ADR 0009](./0009-module-loading-two-phases.md)). Bending one of them to fit would mean fighting the library's own composition model rather than using it, while still carrying its full API surface and a runtime dependency.

### Single global container, no per-module containers

Considered early but rejected: it collapses module boundaries — any provider becomes visible to any other module regardless of `imports`/`exports`, defeating the point of an explicit module graph.

## Consequences

- **Positive**: no runtime dependency for DI; the whole resolution algorithm is auditable in one file.
- **Positive**: `delegate`/`existing` give the module loader exactly the composition primitives it needs (cross-container aliasing with instance identity preserved).
- **Negative**: doesn't match ecosystem expectations coming from NestJS/Angular/InversifyJS; no community documentation or tooling (e.g. no dependency-graph visualizer) beyond what the framework ships itself.
- **Caution**: any new provider shape must be added to `resolve()`'s shape-dispatch chain by hand — there is no library update to pull in.
