---
sidebar_position: 3
---

# Guards

Les guards décident si un message entrant peut atteindre le handler. Vous écrivez une petite classe avec une méthode `canActivate()` et l'attachez à un controller (toutes ses routes) ou à une route unique. Les guards sont résolus par DI, ils peuvent donc injecter des services comme tout autre provider.

## Définir un guard

Un guard est une classe ordinaire avec une seule méthode. Renvoyez `true` pour autoriser le message, `false` pour le rejeter — un `false` fait lever `UnauthorizedError` par le pipeline, que l'`ErrorMapper` mappe vers votre code de rejet (typiquement `'UNAUTHORIZED'`). Il peut injecter n'importe quel provider via son constructeur :

```typescript
import { Guard } from "@spinejs/gateway-core";
import { Injectable } from "@spinejs/core";
import { SessionStore } from "../session";
import type { AppContext } from "./app-context";

@Injectable({ inject: [SessionStore] })
export class SessionGuard implements Guard<AppContext> {
  constructor(private readonly sessionStore: SessionStore) {}

  canActivate(ctx: AppContext): boolean {
    // ctx.session est enrichi par la ContextFactory depuis le session store.
    return ctx.session !== null;
  }
}
```

Le contrat est une seule méthode :

```typescript
interface Guard<Ctx extends GatewayContext> {
  canActivate(ctx: Ctx): boolean | Promise<boolean>;
}
```

Un guard peut aussi lever directement (ex. pour distinguer plusieurs conditions de rejet) ; l'`ErrorMapper` traite ces levées comme un retour `false`.

## Appliquer des guards

Une classe guard peut s'appliquer à deux niveaux. Les deux acceptent des **classes** de guards (pas des instances) ; le container résout les instances à l'initialisation du feature module.

### Niveau classe — `@UseGuards`

Attacher `@UseGuards` à la classe contrôleur applique les guards à **toutes** ses routes — le cas courant pour authentifier un contrôleur entier :

```typescript
import { Controller, UseGuards } from "@spinejs/gateway-core";
import { get } from "./app-context";
import { SessionGuard } from "./session.guard";

@UseGuards(SessionGuard)
@Controller({ inject: [ProjectsStore] })
export class ProjectsController {
  constructor(private readonly projects: ProjectsStore) {}

  // SessionGuard s'exécute avant chaque route ci-dessous.
  list = get("/projects", {}, (_input, ctx) =>
    this.projects.findAll(ctx.session.userId)
  );
  getById = get("/projects/:id", { params: idParam }, ({ params }) =>
    this.projects.findById(params.id)
  );
}
```

:::note Décorateur de classe uniquement
`@UseGuards` est un décorateur de **classe**. Comme les routes sont des champs d'instance (pas des méthodes), il n'existe pas de cible de décorateur au niveau méthode — la granularité par route passe par les options de route (ci-dessous).
:::

### Niveau route — l'option `guards`

Passez `guards: [...]` dans les options d'une route pour ajouter des guards à cette seule route. Ils sont fusionnés **après** les guards de classe du contrôleur :

```typescript
import { Controller, UseGuards } from "@spinejs/gateway-core";
import { get, post } from "./app-context";
import { SessionGuard } from "./session.guard";
import { AdminGuard } from "./admin.guard";

@UseGuards(SessionGuard)
@Controller({ inject: [AdminStore] })
export class AdminController {
  constructor(private readonly store: AdminStore) {}

  // SessionGuard + AdminGuard
  reset = post("/admin/reset", { guards: [AdminGuard] }, () =>
    this.store.reset()
  );

  // SessionGuard seul
  status = get("/admin/status", {}, () => "ok");
}
```

## Résolution des guards

À l'initialisation du feature module (dans `onInit()`), le framework :

1. Parcourt chaque **instance** de contrôleur pour collecter les classes de guards référencées — niveau classe (`@UseGuards`) plus l'option `guards` par route sur les markers de champ.
2. Résout chaque guard depuis le container propre du feature module, en enregistrant à la volée une classe de guard inconnue pour que ses dépendances `@Injectable` se résolvent depuis ce container (exports de ses imports + providers).
3. Construit une `Map<GuardConstructor, Guard<Ctx>>` et la passe à `getRoutes()`, qui attache à chaque route sa liste de guards résolus.

Les guards sont des singletons dans la portée du module — la même instance de `SessionGuard` est réutilisée par toutes les routes qui la référencent.

:::note Pourquoi une résolution paresseuse
Les classes de guards par route vivent dans des champs de contrôleur : elles ne sont connues qu'**après** l'instanciation du contrôleur. Le feature module résout donc les guards paresseusement à l'`onInit` (via son propre container), au lieu de les collecter statiquement à la définition du module. Un guard dont une dépendance n'est pas joignable depuis le container du module échoue à l'init avec une erreur claire.
:::

## Combiner plusieurs guards

Les guards sont vérifiés dans l'ordre : niveau classe d'abord, puis par route. Le premier guard qui renvoie `false` court-circuite — les suivants ne sont pas appelés.

```typescript
@UseGuards(AuthenticatedGuard, RateLimitGuard)
@Controller()
export class PublicApiController {
  // Ordre des guards : AuthenticatedGuard → RateLimitGuard → CsrfGuard
  mutate = post(
    "/api/mutate",
    { body: mutateBody, guards: [CsrfGuard] },
    ({ body }) => this.service.mutate(body)
  );
}
```
