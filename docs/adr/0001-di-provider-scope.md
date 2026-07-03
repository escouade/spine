# ADR 0001 — DI provider scope: `singleton` | `transient`

- **Status**: Accepted
- **Date**: 2026-06-30
- **Scope**: `packages/core` (DI container, decorators)
- **Relation**: extends the container/DI model defined in `packages/core` (see ADR 0002 for its gateway usage). Lays the groundwork for the future per-request/per-event scope (gateway), handled separately.

## Context

The DI container has a single lifecycle: **everything is a singleton** per container.
`Container.resolveToken` caches each resolved instance in `Container.resolved: Map`; every later
`get()` returns the same object. There is no way to declare a provider that yields a **fresh
instance** on each resolution (`transient`).

Concrete needs:

- services holding ephemeral / non-shareable state (builders, accumulators, parameterized
  value-objects) that must not be shared between consumers;
- preparing the ground for a per-request/per-event scope on the gateway side, which builds on the
  same mechanism (a disposable child container that does not cache like its parent).

The existing design accommodates this without a rewrite: a singleton is merely a **caching policy**
in `resolveToken`. Disabling that cache for a given provider = `transient`.

Separately, a class's dependencies are declared today via `@Inject([tokens])`. Adding scope raised
the question of **where** to declare it. Stacking a second decorator
(`@Injectable({ scope }) @Inject([deps])`) was deemed misleading and redundant.

## Decision

### 1. Two scopes, default `singleton`

```ts
export type ProviderScope = "singleton" | "transient"; // default: singleton
```

- `singleton` (default): current behavior — one instance per container, cached.
- `transient`: a fresh instance on **every resolution of the token**; never cached.

A missing `scope` ⇒ `singleton` ⇒ **full backward compatibility**.

### 2. Declaration — `@Injectable` replaces `@Inject`

The class decorator is renamed to **`@Injectable`** (the standard name in NestJS / Angular /
Inversify, with no clash against the already-exported `Provider<T>` type) and **carries both
`inject` and `scope`**. `@Inject` is removed and its usages migrated.

```ts
@Injectable({ inject: [Dep], scope: "transient" })
class Foo {}

@Injectable({ inject: [Dep] }) // scope omitted ⇒ singleton
class Bar {}
```

Dependency type-safety (`CtorDepsMatch`: a token of the wrong type/order/arity = compile error) is
preserved unchanged. No `reflect-metadata`: `@Injectable` writes its metadata on own symbols
(`app-core:inject-deps`, `app-core:scope`), read own-property only — esbuild-compatible, like the
existing code.

### 3. Low-level provider-object form (source of truth)

Scope is also declarable on the provider object — the only way for **non-class** providers
(factory) and the **source of truth** on conflict:

```ts
providers: [
  { provide: Foo, scope: "transient" }, // class, override
  { provide: barToken, factory: makeBar, scope: "transient" }, // factory
  Baz, // bare class with no decorator ⇒ singleton
];
```

The `scope?` field is added to `BaseProvider` (class) and `FactoryProvider` only — the two forms
that _instantiate_. `ValueProvider` (a fixed value) and `DelegateProvider` (cross-module bridge,
already a hidden indirection) do not carry it.

**Priority**: `provider field` > `@Injectable` > default `singleton`. The provider is local to the
module that registers it, hence more specific than the class.

### 4. Single implementation point

The only behavioral change is in `Container.resolveToken`: compute the effective scope and **skip
caching** when `transient`.

```ts
if (this.has(token)) {
  const resolved = this.resolve<T>(token, [...parents]);
  if (this.effectiveScope(token) !== "transient")
    this.resolved.set(key, resolved);
  return resolved;
}
```

Cycle detection (via the `parents` chain in `resolveDeps`) is independent of the cache and stays
unchanged.

### 5. Semantics: a transient injected into a singleton

A `transient` provider **injected into a singleton** is resolved **only once**, when the singleton
is constructed: the singleton captures its instance for its lifetime. "Transient" means "fresh on
each _resolution of the token_", not "fresh on each access from the holder". This is the standard
behavior (NestJS, Angular); per-call scoped injection belongs to a per-request scope, out of scope
for this decision.

## Alternatives considered

### Two stacked decorators (`@Injectable({scope})` + `@Inject([deps])`)

Rejected: redundant stacking, two sources describing one class-provider, confusing to read.

### Keep `@Inject` and fold scope into it (`@Inject([deps], { scope })`)

Rejected: the name `@Inject` no longer describes its role once it carries the lifecycle. A
provider-oriented name (`@Injectable`) is more accurate and aligned with the ecosystem.

### Scope on the binding only (InversifyJS model), no decorator

Considered: clean, but forces going through the provider object even for a bare class, losing the
ergonomics of the decorator already in place for deps. Partially retained: the provider object
remains the source of truth and the only path for non-class providers, while `@Injectable` offers
the class-level sugar.

### `request` scope right now

Deferred: requires a per-request child container and touches the gateway pipeline (controllers
pre-resolved at `onInit`). Handled in a later POC/ADR; this decision lays its foundations
(`transient` = caching disabled, the brick reused by the child container).

## Consequences

- **Positive**: a new `transient` lifecycle with no rewrite — a single caching point touched.
- **Positive**: one ergonomic way to declare a class-provider (`@Injectable`), carrying deps +
  scope, typed, without `reflect-metadata`.
- **Positive**: behavioral backward compatibility (missing scope ⇒ singleton).
- **Positive**: foundations laid for the per-request/per-event scope (gateway).
- **Negative**: `@Inject` → `@Injectable` migration (small footprint: definition/exports, one test
  usage, docs).
- **Caution**: a `transient` injected into a `singleton` is resolved only once — document this
  classic pitfall to avoid expecting a fresh instance per call.
