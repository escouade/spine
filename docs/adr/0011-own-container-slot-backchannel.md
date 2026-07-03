# ADR 0011 — `OWN_CONTAINER_SLOT`: private cross-package container back-channel

- **Status**: Accepted
- **Date**: 2026-07-02
- **Scope**: `packages/core` (`module/module-loader.ts`), consumed by `@spinejs/gateway-core`
- **Relation**: enables the DI route-loader described in [ADR 0002](./0002-gateway-transport-agnostic.md) and the field-form controllers of [ADR 0004](./0004-field-form-routes.md).

## Context

A module's own `Container` (the one holding its declared `providers`, populated with its imports' exported tokens) is otherwise only accessible from inside `module-loader.ts` — `ModuleRef.container` is not exposed on the public module instance.

The gateway's field-form controllers ([ADR 0004](./0004-field-form-routes.md)) declare guards and other DI-resolvable classes as **route fields**, discovered only once the module instance exists (at `onInit` time, by inspecting the controller's own fields) — not upfront the way `providers`/`inject` are declared in `@Module` metadata. Resolving those late-discovered classes needs access to the exact `Container` that was built for that module, with its imports and providers already wired — but `@spinejs/gateway-core` (a downstream package) has no public API to reach it, and `@spinejs/core` doesn't want to grow one just for this.

## Decision

The module loader stamps each module instance with its own `Container`, on a hidden, non-enumerable property, right before `onInit()`:

```ts
const OWN_CONTAINER_SLOT = Symbol.for("spinejs:module-own-container");
...
Object.defineProperty(ref.instance, OWN_CONTAINER_SLOT, {
  value: ref.container,
  enumerable: false,
  configurable: true,
});
```

- **`Symbol.for(...)`, not a unique `Symbol()`** ([contrast with ADR 0007](./0007-injection-token-symbol-identity.md)): the key must be re-derivable by a downstream package that has no import path to the exact symbol instance `core` created — `Symbol.for("spinejs:module-own-container")` lets `@spinejs/gateway-core` compute the same key independently, without `@spinejs/core` exporting the symbol (or anything about this mechanism) from its public API.
- **`enumerable: false`**: the slot must not show up in `Object.keys()`/`JSON.stringify()`/spread of the module instance, or in any generic inspection of "the module's own fields" that the gateway's field-route discovery performs.
- **Written before `onInit()`**: so a module's own `onInit()` — or anything it triggers — could in principle already resolve through it, though in practice the primary consumer is the gateway's route loader running after `onInit`.

This is explicitly **not** a public API, and not part of the DI graph: no token exists for it, `core` never mentions it in exported types, and user code has no supported way to read it.

## Alternatives considered

### Expose `container` as a public field on the module instance / on a base class

Rejected: would force every module to carry a public `container` property (or extend a base class just to get it), leaking an internal implementation detail into user-facing module classes for a need specific to one downstream package's route-discovery mechanism.

### Add a public core API (e.g. `App.getModuleContainer(instance)`)

Rejected for now: would commit `@spinejs/core` to a stable, documented contract for something only one internal consumer (the gateway's late field-discovery) needs. A `Symbol.for` back-channel keeps the coupling contained to the two packages that actually need it, without widening `core`'s public surface.

## Consequences

- **Positive**: the gateway's field-form controllers can resolve late-discovered classes (guards, etc.) against the correct per-module container without `@spinejs/core` growing a bespoke public API for it.
- **Negative**: a private, undocumented cross-package protocol — the coupling between `@spinejs/core` and `@spinejs/gateway-core` around this key exists only in each package's source, not in any exported type. A rename of the key string, or of the mechanism, requires coordinated changes in both packages with no compiler check to catch a mismatch.
- **Caution**: `Symbol.for` uses Node's global symbol registry — a key collision with an unrelated `Symbol.for("spinejs:module-own-container")` elsewhere is theoretically possible (if extremely unlikely given the namespaced string). This is an explicit, accepted trade-off against exposing a public core API prematurely.
