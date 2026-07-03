---
sidebar_position: 2
---

# Modules

A **module** is the structural unit of an SpineJS application. It groups providers (services, factories, values) into a cohesive boundary and exposes a subset of them to other modules via `exports`. The `@Module` decorator is the only way to register a class as a module.

## `@Module` decorator

```typescript
import { Module, InjectionToken } from "@spinejs/core";

const dbToken = new InjectionToken<Database>("database");

@Module({
  providers: [
    DatabaseService,
    { provide: dbToken, factory: () => new Database() },
  ],
  exports: [DatabaseService, dbToken],
})
export class DatabaseModule {}
```

### Metadata fields

| Field       | Type              | Description                                                                                                                                                           |
| ----------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inject`    | `Token[]`         | Constructor dependencies of the module class itself. TypeScript checks the array against the constructor's parameter types and order — a mismatch is a compile error. |
| `imports`   | `ModuleEntry[]`   | Other modules whose exported providers become available inside this module.                                                                                           |
| `providers` | `ProviderEntry[]` | Providers (classes, factories, values) local to this module.                                                                                                          |
| `exports`   | `Token[]`         | Tokens made available to any module that imports this one.                                                                                                            |

### Typed constructor injection

`@Module` doesn't just type `inject` as `Token[]` — it infers the exact tuple you pass and uses it to constrain the constructor signature. Get the order or the type wrong and it won't compile:

```typescript
import { Module, InjectionToken } from "@spinejs/core";

const configToken = new InjectionToken<AppConfig>("app.config");

@Module({
  inject: [configToken],
  imports: [ConfigModule],
})
export class AppModule {
  // TypeScript enforces AppConfig here — wrong type → compile error.
  constructor(private readonly config: AppConfig) {}
}
```

## `DynamicModule`

A `DynamicModule` is the standard pattern for parameterizing a module at import time. The classic idiom is a `static configure()` method that returns the dynamic module object:

```typescript
import { Module, DynamicModule, InjectionToken } from "@spinejs/core";

export interface HttpModuleOptions {
  baseUrl: string;
  timeout?: number;
}

const httpOptionsToken = new InjectionToken<HttpModuleOptions>("http.options");

@Module({
  inject: [httpOptionsToken],
  providers: [{ provide: httpOptionsToken, value: { baseUrl: "" } }],
  exports: [HttpService],
})
export class HttpModule {
  constructor(private readonly options: HttpModuleOptions) {}

  static configure(options: HttpModuleOptions): DynamicModule {
    return {
      module: HttpModule,
      providers: [{ provide: httpOptionsToken, value: options }],
    };
  }
}
```

Consuming module:

```typescript
@Module({
  imports: [
    HttpModule.configure({ baseUrl: "https://api.example.com", timeout: 5000 }),
  ],
})
export class ApiModule {}
```

### `DynamicModule` fields

| Field       | Type                | Description                                                                                                                            |
| ----------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `module`    | `ModuleConstructor` | The module class this dynamic config applies to.                                                                                       |
| `imports`   | `ModuleEntry[]`     | Additional imports for this configuration.                                                                                             |
| `providers` | `ProviderEntry[]`   | Additional or overriding providers.                                                                                                    |
| `exports`   | `Token[]`           | Additional exports.                                                                                                                    |
| `fresh`     | `boolean`           | When `true`, each `configure()` call produces a separate module instance. Default (`false`) merges all configs into a single instance. |

### `fresh: true` — multiple instances

By default, calling `configure()` twice on the same module class merges into one instance. With `fresh: true`, each call produces an independent instance, identified by the `DynamicModule` object reference rather than the class:

```typescript
@Module({ inject: [dbOptionsToken] })
export class DbModule {
  static configure(options: DbOptions): DynamicModule {
    return {
      module: DbModule,
      fresh: true,
      providers: [{ provide: dbOptionsToken, value: options }],
    };
  }
}

// Two independent database connections:
@Module({
  imports: [
    DbModule.configure({ url: "postgres://primary" }),
    DbModule.configure({ url: "postgres://replica" }),
  ],
})
export class AppModule {}
```

## `ModuleEntry`

`ModuleEntry` is the union of everything that can appear in `imports` or be passed to `new App()`:

```typescript
type ModuleEntry = ModuleConstructor | DynamicModule | ModuleNode;
```

- **`ModuleConstructor`** — a bare class decorated with `@Module`.
- **`DynamicModule`** — a configured module object (typically from a `static configure()` call).
- **`ModuleNode`** — an already-resolved node (internal; produced by the loader).

## Imports and exports

Provider visibility follows strict boundaries:

- Providers declared in a module's `providers` are **local** by default — invisible to any importer.
- A provider must be listed in `exports` to be accessible from outside.
- Exporting a token only works if the token is registered as a provider in the same module (or re-exported from an import).

```typescript
@Module({
  providers: [UserRepository, UserService],
  exports: [UserService], // UserRepository stays private
})
export class UserModule {}

@Module({
  imports: [UserModule],
  // UserService is available here; UserRepository is not.
})
export class OrderModule {}
```

## Module lifecycle

Module classes may implement lifecycle interfaces. The `App` calls them automatically in the right order:

```typescript
import { Module, OnInit, OnStart, OnStop } from "@spinejs/core";

@Module({ inject: [DatabaseService] })
export class AppModule implements OnInit, OnStart, OnStop {
  constructor(private readonly db: DatabaseService) {}

  async onInit(): Promise<void> {
    // Called during app.init(), after all dependencies are initialized.
    await this.db.connect();
  }

  async onStart(): Promise<void> {
    // Called during app.start(), after the full module graph is initialized.
    await this.db.runMigrations();
  }

  async onStop(): Promise<void> {
    // Called during app.stop(), in reverse init order.
    await this.db.disconnect();
  }
}
```

See the [Lifecycle](./lifecycle) page for the full ordering guarantees.
