# ADR 0007 — `InjectionToken` resolves by `Symbol()` identity, assumes monolithic bundling

- **Status**: Accepted
- **Date**: 2026-07-02
- **Scope**: `packages/core` (`container/injection-token.ts`)
- **Relation**: complements [ADR 0006](./0006-custom-di-container.md) (custom container).

## Context

`InjectionToken<T>` is the non-class provider token (used for values, interfaces, and anything that isn't itself a constructor). Its resolution key needs to distinguish two unrelated tokens even when they happen to be declared with the same human-readable description (e.g. two different packages both declaring a token named `"config"`).

JavaScript offers two ways to mint a `Symbol` for this:

- `Symbol(description)` — always unique, even for the same description called twice.
- `Symbol.for(description)` — looked up in (and inserted into) the global symbol registry; two calls with the same description return the _same_ symbol.

## Decision

```ts
export class InjectionToken<T = unknown> {
  readonly key: symbol;
  constructor(public readonly description: string) {
    this.key = Symbol(description);
  }
}
```

`key` is minted with `Symbol()`, never `Symbol.for()`. Resolution (`tokenKey`, `Container.add`/`get`) compares tokens by this `key`, never by `description`. `description` is carried purely for error messages and `toString()`.

**Consequence of this choice**: a token must be defined once, exported from its module, and imported by reference everywhere it's provided or injected. Redeclaring `new InjectionToken("config")` in a second file creates a _second_, unrelated token — even though the description reads the same.

**Underlying assumption**: this only holds within a single copy of the module graph. If the app were ever split into multiple bundles that each load their own copy of `@spinejs/core` (and thus their own copy of a shared token's module), two copies of "the same" token would carry two different `Symbol()` values and silently fail to match. The framework accepts this because its target — a single Electron main-process bundle — is never split that way.

## Alternatives considered

### `Symbol.for(description)`

Rejected: two _unrelated_ tokens that happen to share a description would silently resolve to the same key. That failure mode is worse than the one this design produces — a forgotten/duplicated token import instead throws a loud `Unknown provider` error at resolution time, which is far easier to diagnose than a silent cross-token collision.

### String keys instead of symbols

Not seriously considered: strictly worse than `Symbol.for()` on the same collision axis (accidental string clashes are more likely than accidental Symbol.for description clashes), with none of Symbol's benefits (no accidental `Object.keys`/`JSON.stringify` leakage, no risk of `toString()` coercion equating two different tokens).

## Consequences

- **Positive**: duplicate/forgotten token declarations fail loudly (`Unknown provider`) instead of silently resolving to the wrong provider.
- **Positive**: `description` stays free for human-readable debugging without any risk of affecting resolution.
- **Negative / Caution**: relies on the module graph being loaded as a single copy. A future multi-bundle architecture (e.g. dynamically loaded plugins each bundling their own `@spinejs/core`) would break token identity across bundle boundaries and requires revisiting this decision (likely a move to `Symbol.for` with a namespaced description, or an explicit cross-bundle token registry).
