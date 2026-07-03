---
sidebar_position: 3
---

# Dependency Injection

SpineJS includes a synchronous, cycle-detecting DI container. It resolves providers lazily on first request and caches the result — each token resolves according to its [scope](#provider-scopes) (`singleton` by default) within a container scope.

## Declaring and injecting a service

Most DI is one decorator. Mark a class `@Injectable`, list what it needs in `inject`, and register it in a module — the container constructs it and wires the dependencies:

```typescript
import { Injectable, Module } from "@spinejs/core";

@Injectable()
export class Clock {
  now() {
    return new Date();
  }
}

@Injectable({ inject: [Clock] })
export class GreetingService {
  constructor(private readonly clock: Clock) {}
  greet() {
    return `Hello at ${this.clock.now().toISOString()}`;
  }
}

@Module({ providers: [Clock, GreetingService] })
export class GreetingModule {}
```

`inject` is type-checked: the tokens' resolved types must line up with the constructor parameters, in order — swap two and it is a compile error. That covers the common case.

The rest of this page is the fuller toolbox — token kinds, the five provider shapes, scopes, and the container API — for when a plain class reference is not enough (interfaces, pre-built values, factories, aliases).

## `InjectionToken<T>`

`InjectionToken<T>` is a typed, opaque token used as a DI key for values and interfaces (where a class reference is not available or not appropriate).

```typescript
import { InjectionToken } from "@spinejs/core";

// The generic T flows through to container.get<T>(token) call sites.
export const logLevelToken = new InjectionToken<string>("log.level");
export const configToken = new InjectionToken<AppConfig>("app.config");
```

Each `InjectionToken` instance creates a unique `Symbol` internally. Two tokens with the same description string are still distinct — there are no name collisions.

## Provider types

The `Provider<T>` union has five shapes:

### `BaseProvider` — class constructor

The simplest form: give the container a class reference and let it instantiate it.

```typescript
import { Module } from "@spinejs/core";
import { UserService } from "./user.service";

@Module({
  providers: [UserService], // shorthand for { provide: UserService }
})
export class UserModule {}
```

When the class has constructor dependencies, declare them with `@Injectable` or with `inject` on the module:

```typescript
import { Injectable, InjectionToken } from "@spinejs/core";

const dbToken = new InjectionToken<Database>("database");

@Injectable({ inject: [dbToken] })
export class UserService {
  constructor(private readonly db: Database) {}
}
```

### `FactoryProvider` — factory function

Use a factory when construction logic cannot be expressed as a plain constructor call:

```typescript
import { InjectionToken } from "@spinejs/core";

const validatorToken = new InjectionToken<Validator>("validator");

@Module({
  providers: [
    {
      provide: validatorToken,
      inject: [ConfigService],
      factory: (config: ConfigService) =>
        new ZodValidator(config.get(strictModeKey)),
    },
  ],
  exports: [validatorToken],
})
export class ValidationModule {}
```

The `inject` array is resolved by the container before the factory is called. The factory's return type must match `T` of the `InjectionToken<T>`.

### `ValueProvider` — pre-built value

Use `value` when you have a ready-made instance or a primitive:

```typescript
import { InjectionToken } from "@spinejs/core";

const appVersionToken = new InjectionToken<string>("app.version");

@Module({
  providers: [
    { provide: appVersionToken, value: process.env.APP_VERSION ?? "0.0.0" },
  ],
  exports: [appVersionToken],
})
export class CoreModule {}
```

A value provider is particularly useful for `DynamicModule.configure()` patterns where the caller supplies a configuration object.

### `DelegateProvider` — lazy forwarding

A delegate defers resolution to a `() => T` thunk. The container calls it on the first `get()` request. This is useful for injecting values from a parent container without importing it:

```typescript
import { InjectionToken } from "@spinejs/core";

const dbToken = new InjectionToken<Database>("database");

@Module({
  providers: [
    {
      provide: dbToken,
      delegate: () => globalContainer.get(dbToken),
    },
  ],
})
export class ChildModule {}
```

### `ExistingProvider` — pure alias

An existing provider resolves `provide` by resolving `existing` instead — no new instance, same cached singleton, shared identity. Useful for exposing one provider under a second, more specific token (e.g. a typed subclass used purely as a DI marker):

```typescript
import { InjectionToken } from "@spinejs/core";

@Module({
  providers: [Database, { provide: legacyDbToken, existing: Database }],
})
export class DataModule {}
```

`container.get(legacyDbToken) === container.get(Database)` — both tokens resolve to the exact same instance.

## `@Injectable` decorator

`@Injectable` is the class-level decorator for declaring constructor dependencies without `reflect-metadata`. It takes an options object `{ inject, scope }` rather than a bare array: `inject` lists the dependency tokens, and the optional `scope` sets the provider's lifecycle (see [Provider scopes](#provider-scopes)). It is type-safe: TypeScript ties each token's resolved type to the corresponding constructor parameter position.

```typescript
import { Injectable, InjectionToken } from "@spinejs/core";

const cacheToken = new InjectionToken<CacheService>("cache");
const dbToken = new InjectionToken<Database>("database");

@Injectable({ inject: [dbToken, cacheToken] })
export class UserRepository {
  // TypeScript enforces (Database, CacheService) — swapping them is a compile error.
  constructor(
    private readonly db: Database,
    private readonly cache: CacheService
  ) {}
}
```

Under the hood, this type-safety is powered by `ResolvedTuple<D>`: a utility type that maps a tuple of tokens to the tuple of the types they resolve to.

```typescript
type D = [InjectionToken<Database>, InjectionToken<CacheService>];
// ResolvedTuple<D> = [Database, CacheService]
```

Both `@Injectable` and `@Module` use `ResolvedTuple<D>` to constrain the decorated class's constructor to exactly that tuple — get the order or the types wrong and TypeScript rejects it at compile time, before the container ever runs. You rarely write `ResolvedTuple` yourself; it's inferred automatically from the `inject` array you pass in.

Modules typically use the `inject` field on `@Module` instead of `@Injectable` directly:

```typescript
@Module({
  inject: [dbToken, cacheToken],
  imports: [DatabaseModule, CacheModule],
})
export class UserModule {
  constructor(
    private readonly db: Database,
    private readonly cache: CacheService
  ) {}
}
```

Both work the same at runtime — `@Module({ inject })` takes precedence over `@Injectable` when both are present.

## Provider scopes

A provider has a lifecycle **scope** that controls how its instances are cached:

- `singleton` (default): one instance per container, created on first resolution and reused.
- `transient`: a fresh instance on every resolution, never cached.

Declare it on the provider object, or via `@Injectable({ scope })` on a class:

```ts
// On the provider object (also the only form for factory providers):
{ provide: ReportBuilder, scope: "transient" }
{ provide: idToken, factory: makeId, scope: "transient" }

// On the class:
@Injectable({ scope: "transient" })
class ReportBuilder {}
```

When both are set, the provider object wins (it is local to the registering module). A missing scope means `singleton`.

> **Transient into a singleton:** a transient injected into a singleton is resolved **once**, when the singleton is constructed — the singleton captures that instance for its lifetime. "Transient" means a fresh instance per _resolution of the token_, not per access from the holder (the standard NestJS/Angular behavior).

For per-request state (current user, correlation id), SpineJS does not add a DI "request" scope —
use [CLS](../extensions/cls.md) instead, which keeps services as singletons.

## Container resolution rules

1. **First registration wins.** If the same token is registered multiple times (common when a shared export is re-imported by several modules), the first registration is kept. Subsequent duplicates are silently dropped (logged at `verbose`).
2. **Singletons per container.** A resolved value is cached after the first `get()` call. Factories and constructors run exactly once per container scope.
3. **Parent container fallback.** Each module has its own child container. If a token is not found locally, resolution walks up to the global container.
4. **Cycle detection.** Synchronous circular dependencies (`A → B → A`) are detected at resolve time and throw a descriptive error with the resolution chain.

## Container API

The `Container` class is not typically used directly — the `App` and `ModuleLoader` manage it. For advanced use cases (e.g. building a test harness):

```typescript
import { Container, InjectionToken } from "@spinejs/core";
import { AppLogger } from "@spinejs/core";

const logger = new AppLogger();
const container = new Container(logger, "Container.Test");

const serviceToken = new InjectionToken<MyService>("my-service");

container.add({ provide: serviceToken, factory: () => new MyService() });

const service = container.get<MyService>(serviceToken);
```

| Method                 | Description                                                        |
| ---------------------- | ------------------------------------------------------------------ |
| `add(provider)`        | Register a single provider. First registration wins.               |
| `addMany(providers[])` | Register multiple providers in batch.                              |
| `get<T>(token)`        | Resolve (and cache) a token. Throws if not found.                  |
| `has(token)`           | Returns `true` if the token is registered (does not check parent). |
