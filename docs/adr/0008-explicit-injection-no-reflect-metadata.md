# ADR 0008 — Explicit typed injection, no `reflect-metadata`

- **Status**: Accepted
- **Date**: 2026-07-02
- **Scope**: `packages/core` (`container/injectable.ts`, `module/module-decorator.ts`)
- **Relation**: complements [ADR 0006](./0006-custom-di-container.md) (custom container) and [ADR 0001](./0001-di-provider-scope.md) (`@Injectable` origin).

## Context

The mainstream way to declare a class's constructor dependencies via decorators (NestJS, Angular, InversifyJS) relies on `reflect-metadata`: a parameter decorator captures each param's design-time type, and the DI container inspects that reflected metadata at resolution time to auto-wire dependencies — no explicit dependency list needed.

That approach requires:

- the `reflect-metadata` polyfill loaded at runtime;
- `emitDecoratorMetadata` in the TypeScript compiler options;
- a decorator/type-emission pipeline that survives the build.

This framework targets both **legacy** (`experimentalDecorators`) and **stage-3** decorators, and is built with **esbuild**, which strips TypeScript's legacy decorator metadata emission entirely — there is no reflected parameter-type data available at runtime to read, with or without a polyfill loaded. Any design depending on `emitDecoratorMetadata` is a non-starter under this build.

## Decision

Dependencies are declared **explicitly**, as an ordered array, on the class or module itself:

```ts
@Injectable({ inject: [Dep], scope: "transient" })
class Foo {
  constructor(dep: Dep) {}
}

@Module({ inject: [appToken, loggerToken] })
class Foo {
  constructor(app: App, logger: Logger) {}
}
```

### 1. Metadata stored as own-property, not via `reflect-metadata`

`Injectable`/`Module` write to a `Symbol.for(...)`-keyed own property on the class (`defineOwnMeta`), read back with `readOwnMeta` — plain object metadata, no reflection API involved:

```ts
const INJECT_DEPS = Symbol.for("app-core:inject-deps");
export function Injectable<const D extends readonly Token[] = []>(
  options: InjectableOptions<D> = {}
) {
  return (cls) => {
    if (options.inject) defineOwnMeta(cls, INJECT_DEPS, [...options.inject]);
    // ...
    return cls;
  };
}
```

Because this is "a plain function that sets metadata on the class," it behaves identically whether the project compiles with legacy or stage-3 decorators — esbuild dropping legacy decorator _metadata emission_ doesn't matter, since none is relied upon.

### 2. Own-property-only read (no inheritance)

`ownDeps`/`getInjectedDeps` read metadata with `Object.getOwnPropertyDescriptor`-style own-property access, not a prototype-chain walk. A subclass of an `@Injectable` class does **not** inherit its parent's `inject` array — each class must declare its own if it has different constructor deps. This avoids a subclass silently picking up a mismatched dependency list from a base class it doesn't share a constructor signature with.

### 3. Compile-time enforcement via `CtorDepsMatch`

```ts
export type CtorDepsMatch<
  C,
  D extends readonly Token[]
> = ConstructorParameters<C> extends ResolvedTuple<D> ? unknown : never;
```

The `inject` array's tuple type is threaded through to constrain the constructor's parameter types: a wrong token, wrong order, or wrong arity is a **compile error**, not a runtime failure discovered only when the container tries to resolve it. This is the main thing lost by not having `reflect-metadata` auto-wiring (no need to keep constructor params and an inject list in sync by hand, since the compiler enforces the sync) — but it's compensated by generic type constraints instead of runtime reflection.

## Alternatives considered

### `reflect-metadata` + parameter decorators (NestJS/Angular style)

Rejected: incompatible with the esbuild build (no decorator metadata emission survives) and with dual legacy/stage-3 decorator support — `reflect-metadata`'s metadata emission is tied to `experimentalDecorators` + `emitDecoratorMetadata`, a combination stage-3 decorators don't support the same way.

### Runtime type inspection without `reflect-metadata` (custom AST/type extraction)

Not pursued: would require either a custom build-time codegen step (parsing constructor signatures to emit an inject list) or runtime type introspection unavailable in JS. Explicit `inject:` arrays achieve the same safety more simply, pushed to compile time via `CtorDepsMatch` instead of a custom toolchain step.

## Consequences

- **Positive**: works identically under legacy and stage-3 decorators, no `reflect-metadata` polyfill, esbuild-safe.
- **Positive**: dependency list is compile-time checked against the constructor signature (wrong type/order/arity fails to compile).
- **Negative**: verbose — every class/module must repeat its dependencies in an `inject:` array parallel to its constructor signature, instead of the container inferring it automatically from parameter types.
- **Caution**: metadata is own-property only; a subclass of an `@Injectable`/`@Module` class must redeclare its own `inject:` if its constructor differs — the framework will not walk the prototype chain to find it.
