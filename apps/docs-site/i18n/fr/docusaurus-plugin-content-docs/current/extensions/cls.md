---
sidebar_position: 3
---

# CLS (contexte de requête)

`@spinejs/cls` fournit un état ambiant par requête via l'`AsyncLocalStorage` de Node, exposé comme un
singleton injectable `ClsService`. Utilisez-le pour rendre les données de requête (l'utilisateur
authentifié, un identifiant de corrélation, le tenant courant) disponibles au fond d'un graphe de
services **sans faire passer un objet de contexte** à travers chaque méthode — et sans le coût d'une
portée DI « request » (pas de réinstanciation par requête).

## Installation

`ClsModule` est un module SpineJS standard. Importez-le partout où vous injectez `ClsService` :

```typescript
import { Module } from "@spinejs/core";
import { ClsModule } from "@spinejs/cls";

@Module({ imports: [ClsModule] })
export class SomeFeatureModule {}
```

`ClsModule` fournit un unique `ClsService` partagé. Importez-le librement dans plusieurs modules — ils
voient tous la même instance, ce qui est nécessaire pour que le code qui ouvre une portée et celui qui
la lit partagent le même `AsyncLocalStorage`.

## API

`ClsService<T extends object = ClsStore>` — générique sur la forme du store. `ClsService` nu (sans
sous-classe) n'est pas typé : `get`/`set` acceptent n'importe quelle clé string et retournent
`unknown`. On le restreint une fois par app via une sous-classe :

```typescript
import { ClsService } from "@spinejs/cls";

interface AppStore {
  user: string;
  reqId: string;
}

// Corps vide : juste un token DI typé + un type d'injection, jamais instancié directement.
export class DispatchContext extends ClsService<AppStore> {}
```

- `run<R>(seed, fn): R` — ouvre une portée initialisée avec une copie de `seed`, exécute `fn` à
  l'intérieur.
- `get active(): boolean` — indique si une portée est actuellement active.
- `get<K extends keyof T>(key): T[K] | undefined` — lit la portée active, vérifié contre `T`
  (`undefined` en dehors de toute portée).
- `set<K extends keyof T>(key, value): void` — écrit dans la portée active, vérifié (lève en dehors
  d'une portée).
- `has(key): boolean` — indique si la clé existe dans la portée active.

## Ouvrir une portée par requête

`ClsService.run()` est la frontière par requête. Avec la gateway, ouvrez-la depuis un interceptor — le
cœur de la gateway n'est pas modifié. `@spinejs/cls` exporte un `ClsInterceptor` générique, donc pas
besoin d'en écrire un à la main : par défaut il initialise le store en étalant tout le contexte de
dispatch ; passez une fonction `seed` pour tout ce qui est dérivé (ici un `reqId` généré) :

```typescript
import { randomUUID } from "node:crypto";
import { ClsInterceptor, ClsService } from "@spinejs/cls";

// dans le configure({ interceptors }) de votre transport :
{
  inject: [ClsService],
  factory: (cls: ClsService) => [
    new ClsInterceptor<AppContext>(cls, (ctx) => ({ user: ctx.user, reqId: randomUUID() })),
  ],
}
```

## Lire le contexte

Injectez votre sous-classe typée `DispatchContext` dans n'importe quel service singleton — sans
paramètre `ctx`, sans factory : elle est aliasée vers le même singleton `ClsService` via un provider
`existing` (même instance, juste re-typée contre `AppStore`, pas d'objet en plus) :

```typescript
@Module({
  providers: [AuditService, { provide: DispatchContext, existing: ClsService }],
})
export class FeatureModule {}
```

```typescript
import { Injectable } from "@spinejs/core";
import { DispatchContext } from "./dispatch-context";

@Injectable({ inject: [DispatchContext] })
export class AuditService {
  constructor(private readonly dispatchContext: DispatchContext) {}
  log(action: string) {
    const user = this.dispatchContext.get("user"); // typé : string | undefined
    // ...
  }
}
```

## Concurrence

`AsyncLocalStorage` lie le store au contexte d'exécution asynchrone, pas à une instance. Deux requêtes
concurrentes obtiennent des stores isolés, donc le même singleton retourne la valeur propre à chaque
requête.

## Recommandations

- Centralisez l'`AsyncLocalStorage` dans `ClsService` — n'en instanciez jamais ailleurs.
- Pour des besoins superficiels (un handler qui lit `ctx.user` directement), utilisez simplement le
  contexte ; CLS se justifie quand un graphe de services profond devrait sinon faire passer `ctx`
  partout.
- Appeler `get` en dehors d'une portée retourne `undefined` ; `set` lève une exception. Assurez-vous
  que chaque point d'entrée ayant besoin du contexte ouvre une portée avec `run()`.

Un exemple complet et exécutable se trouve dans `examples/cls-request-context`.
