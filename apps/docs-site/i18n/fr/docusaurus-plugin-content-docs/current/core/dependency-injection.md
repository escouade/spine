---
sidebar_position: 3
---

# Injection de dépendances

SpineJS inclut un conteneur DI synchrone avec détection de cycles. Il résout les providers paresseusement à la première demande et met le résultat en cache — chaque token se résout selon sa [portée](#portées-de-provider) (`singleton` par défaut) au sein d'une portée de conteneur.

## Déclarer et injecter un service

La DI se résume le plus souvent à un décorateur. Marquez une classe `@Injectable`, listez ses besoins dans `inject`, et enregistrez-la dans un module — le conteneur la construit et câble les dépendances :

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

`inject` est vérifié au type : les types résolus des tokens doivent correspondre aux paramètres du constructeur, dans l'ordre — en inverser deux est une erreur de compilation. Cela couvre le cas courant.

Le reste de cette page est la boîte à outils complète — types de token, les cinq formes de provider, les portées, et l'API du conteneur — pour quand une simple référence de classe ne suffit pas (interfaces, valeurs pré-construites, factories, alias).

## `InjectionToken<T>`

`InjectionToken<T>` est un token typé et opaque utilisé comme clé DI pour des valeurs et des interfaces (lorsqu'une référence de classe n'est pas disponible ou pas appropriée).

```typescript
import { InjectionToken } from "@spinejs/core";

// The generic T flows through to container.get<T>(token) call sites.
export const logLevelToken = new InjectionToken<string>("log.level");
export const configToken = new InjectionToken<AppConfig>("app.config");
```

Chaque instance d'`InjectionToken` crée un `Symbol` unique en interne. Deux tokens ayant la même chaîne de description restent distincts — il n'y a pas de collision de noms.

## Types de providers

L'union `Provider<T>` a cinq formes :

### `BaseProvider` — constructeur de classe

La forme la plus simple : donnez au conteneur une référence de classe et laissez-le l'instancier.

```typescript
import { Module } from "@spinejs/core";
import { UserService } from "./user.service";

@Module({
  providers: [UserService], // shorthand for { provide: UserService }
})
export class UserModule {}
```

Quand la classe a des dépendances de constructeur, déclarez-les avec `@Injectable` ou avec `inject` sur le module :

```typescript
import { Injectable, InjectionToken } from "@spinejs/core";

const dbToken = new InjectionToken<Database>("database");

@Injectable({ inject: [dbToken] })
export class UserService {
  constructor(private readonly db: Database) {}
}
```

### `FactoryProvider` — fonction factory

Utilisez une factory quand la logique de construction ne peut pas s'exprimer comme un simple appel de constructeur :

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

Le tableau `inject` est résolu par le conteneur avant l'appel de la factory. Le type de retour de la factory doit correspondre au `T` de l'`InjectionToken<T>`.

### `ValueProvider` — valeur pré-construite

Utilisez `value` lorsque vous disposez d'une instance prête à l'emploi ou d'une primitive :

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

Un value provider est particulièrement utile pour les patterns `DynamicModule.configure()` où l'appelant fournit un objet de configuration.

### `DelegateProvider` — transfert paresseux

Un delegate diffère la résolution à un thunk `() => T`. Le conteneur l'appelle à la première demande `get()`. C'est utile pour injecter des valeurs depuis un conteneur parent sans l'importer :

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

### `ExistingProvider` — alias pur

Un existing provider résout `provide` en résolvant `existing` à la place — pas de nouvelle instance, même singleton mis en cache, identité partagée. Utile pour exposer un provider sous un second token plus spécifique (ex. une sous-classe typée utilisée uniquement comme marqueur DI) :

```typescript
import { InjectionToken } from "@spinejs/core";

@Module({
  providers: [Database, { provide: legacyDbToken, existing: Database }],
})
export class DataModule {}
```

`container.get(legacyDbToken) === container.get(Database)` — les deux tokens résolvent vers exactement la même instance.

## Décorateur `@Injectable`

`@Injectable` est le décorateur de niveau classe pour déclarer les dépendances de constructeur sans `reflect-metadata`. Il prend un objet d'options `{ inject, scope }` plutôt qu'un simple tableau : `inject` liste les tokens de dépendances, et le `scope` optionnel définit le cycle de vie du provider (voir [Portées de provider](#portées-de-provider)). Il est type-safe : TypeScript lie le type résolu de chaque token à la position correspondante du paramètre de constructeur.

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

Sous le capot, cette sécurité de type est portée par `ResolvedTuple<D>` : un type utilitaire qui mappe un tuple de tokens vers le tuple des types qu'ils résolvent.

```typescript
type D = [InjectionToken<Database>, InjectionToken<CacheService>];
// ResolvedTuple<D> = [Database, CacheService]
```

`@Injectable` et `@Module` utilisent tous deux `ResolvedTuple<D>` pour contraindre le constructeur de la classe décorée à exactement ce tuple — un ordre ou un type erroné est rejeté par TypeScript à la compilation, avant même que le conteneur s'exécute. Vous n'avez quasiment jamais besoin d'écrire `ResolvedTuple` vous-même ; il est inféré automatiquement à partir du tableau `inject` que vous fournissez.

Les modules utilisent typiquement le champ `inject` de `@Module` plutôt que `@Injectable` directement :

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

Les deux fonctionnent de la même façon à l'exécution — `@Module({ inject })` prend le pas sur `@Injectable` quand les deux sont présents.

## Portées de provider

Un provider a une **portée** (scope) de cycle de vie qui contrôle la mise en cache de ses instances :

- `singleton` (défaut) : une instance par conteneur, créée à la première résolution puis réutilisée.
- `transient` : une instance neuve à chaque résolution, jamais mise en cache.

Déclarez-la sur l'objet provider, ou via `@Injectable({ scope })` sur une classe :

```ts
// Sur l'objet provider (seule forme pour les factory providers) :
{ provide: ReportBuilder, scope: "transient" }
{ provide: idToken, factory: makeId, scope: "transient" }

// Sur la classe :
@Injectable({ scope: "transient" })
class ReportBuilder {}
```

Quand les deux sont présents, l'objet provider l'emporte (il est local au module qui l'enregistre). Une portée absente vaut `singleton`.

> **Transient dans un singleton :** un transient injecté dans un singleton est résolu **une seule fois**, à la construction du singleton — celui-ci capture cette instance pour sa durée de vie. « Transient » signifie une instance neuve par _résolution du token_, pas par accès depuis le porteur (comportement standard NestJS/Angular).

Pour l'état par requête (utilisateur courant, identifiant de corrélation), SpineJS n'ajoute pas de
portée DI « request » — utilisez plutôt [CLS](../extensions/cls.md), qui garde les services en
singletons.

## Règles de résolution du conteneur

1. **Le premier enregistrement gagne.** Si le même token est enregistré plusieurs fois (fréquent quand un export partagé est ré-importé par plusieurs modules), le premier enregistrement est conservé. Les doublons suivants sont silencieusement ignorés (journalisés en `verbose`).
2. **Singletons par conteneur.** Une valeur résolue est mise en cache après le premier appel `get()`. Les factories et constructeurs s'exécutent exactement une fois par portée de conteneur.
3. **Repli sur le conteneur parent.** Chaque module a son propre conteneur enfant. Si un token n'est pas trouvé localement, la résolution remonte jusqu'au conteneur global.
4. **Détection de cycles.** Les dépendances circulaires synchrones (`A → B → A`) sont détectées au moment de la résolution et lèvent une erreur descriptive avec la chaîne de résolution.

## API du conteneur

La classe `Container` n'est typiquement pas utilisée directement — l'`App` et le `ModuleLoader` la gèrent. Pour des cas d'usage avancés (par ex. construire un harnais de test) :

```typescript
import { Container, InjectionToken } from "@spinejs/core";
import { AppLogger } from "@spinejs/core";

const logger = new AppLogger();
const container = new Container(logger, "Container.Test");

const serviceToken = new InjectionToken<MyService>("my-service");

container.add({ provide: serviceToken, factory: () => new MyService() });

const service = container.get<MyService>(serviceToken);
```

| Méthode                | Description                                                            |
| ---------------------- | ---------------------------------------------------------------------- |
| `add(provider)`        | Enregistre un seul provider. Le premier enregistrement gagne.          |
| `addMany(providers[])` | Enregistre plusieurs providers en lot.                                 |
| `get<T>(token)`        | Résout (et met en cache) un token. Lève une erreur si introuvable.     |
| `has(token)`           | Retourne `true` si le token est enregistré (ne vérifie pas le parent). |
