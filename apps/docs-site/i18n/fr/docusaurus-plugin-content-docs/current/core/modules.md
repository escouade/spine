---
sidebar_position: 2
---

# Modules

Un **module** est l'unité structurelle d'une application SpineJS. Il regroupe des providers (services, factories, valeurs) dans une frontière cohérente et expose un sous-ensemble d'entre eux aux autres modules via `exports`. Le décorateur `@Module` est le seul moyen d'enregistrer une classe comme module.

## Décorateur `@Module`

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

### Champs de métadonnées

| Champ       | Type              | Description                                                                                                                                                                                      |
| ----------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `inject`    | `Token[]`         | Dépendances de constructeur de la classe du module elle-même. TypeScript vérifie le tableau face aux types et à l'ordre des paramètres du constructeur — un écart est une erreur de compilation. |
| `imports`   | `ModuleEntry[]`   | Autres modules dont les providers exportés deviennent disponibles dans ce module.                                                                                                                |
| `providers` | `ProviderEntry[]` | Providers (classes, factories, valeurs) locaux à ce module.                                                                                                                                      |
| `exports`   | `Token[]`         | Tokens rendus disponibles à tout module qui importe celui-ci.                                                                                                                                    |

### Injection de constructeur typée

`@Module` ne type pas juste `inject` en `Token[]` — il infère le tuple exact que tu passes et l'utilise pour contraindre la signature du constructeur. Te tromper d'ordre ou de type empêche la compilation :

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

Un `DynamicModule` est le pattern standard pour paramétrer un module au moment de son import. L'idiome classique est une méthode `static configure()` qui retourne l'objet module dynamique :

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

Module consommateur :

```typescript
@Module({
  imports: [
    HttpModule.configure({ baseUrl: "https://api.example.com", timeout: 5000 }),
  ],
})
export class ApiModule {}
```

### Champs de `DynamicModule`

| Champ       | Type                | Description                                                                                                                                                 |
| ----------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module`    | `ModuleConstructor` | La classe de module à laquelle cette config dynamique s'applique.                                                                                           |
| `imports`   | `ModuleEntry[]`     | Imports supplémentaires pour cette configuration.                                                                                                           |
| `providers` | `ProviderEntry[]`   | Providers supplémentaires ou surchargés.                                                                                                                    |
| `exports`   | `Token[]`           | Exports supplémentaires.                                                                                                                                    |
| `fresh`     | `boolean`           | Quand `true`, chaque appel à `configure()` produit une instance de module distincte. Le défaut (`false`) fusionne toutes les configs en une seule instance. |

### `fresh: true` — instances multiples

Par défaut, appeler `configure()` deux fois sur la même classe de module fusionne en une seule instance. Avec `fresh: true`, chaque appel produit une instance indépendante, identifiée par la référence de l'objet `DynamicModule` plutôt que par la classe :

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

`ModuleEntry` est l'union de tout ce qui peut apparaître dans `imports` ou être passé à `new App()` :

```typescript
type ModuleEntry = ModuleConstructor | DynamicModule | ModuleNode;
```

- **`ModuleConstructor`** — une classe nue décorée avec `@Module`.
- **`DynamicModule`** — un objet module configuré (typiquement issu d'un appel `static configure()`).
- **`ModuleNode`** — un nœud déjà résolu (interne ; produit par le loader).

## Imports et exports

La visibilité des providers suit des frontières strictes :

- Les providers déclarés dans le `providers` d'un module sont **locaux** par défaut — invisibles à tout importateur.
- Un provider doit figurer dans `exports` pour être accessible de l'extérieur.
- Exporter un token ne fonctionne que si le token est enregistré comme provider dans le même module (ou ré-exporté depuis un import).

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

## Cycle de vie d'un module

Les classes de module peuvent implémenter des interfaces de cycle de vie. L'`App` les appelle automatiquement dans le bon ordre :

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

Voir la page [Cycle de vie](./lifecycle) pour les garanties d'ordre complètes.
