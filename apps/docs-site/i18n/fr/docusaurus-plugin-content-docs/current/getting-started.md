---
sidebar_position: 2
---

# Prise en main

Ce guide construit une petite app SpineJS complète : une API HTTP avec une ressource, d'un dossier vide jusqu'à une requête en direct. On procède de haut en bas — comme vous développez vraiment : point d'entrée d'abord, puis le module racine, puis un controller, puis le service derrière.

À la fin, vous aurez un `GET /users` et un `POST /users` servis en HTTP, avec input validé et handlers typés, dans cette arborescence :

```
src/
  main.ts
  app-context.ts
  modules/
    app.module.ts
    user/
      user.module.ts
      user.controller.ts
      user.service.ts
```

## Installation

```bash
yarn add @spinejs/core @spinejs/http-gateway zod
```

- `@spinejs/core` — le système de modules, le conteneur DI, et l'orchestrateur `App`.
- `@spinejs/http-gateway` — le transport HTTP (bâti sur [Hono](https://hono.dev)).
- `zod` — la librairie de schémas utilisée pour valider l'input.

## 1. Le point d'entrée — `main.ts`

`App` prend votre module racine, construit le graphe et pilote le cycle de vie. Le `port` de la gateway (câblée juste après) la fait écouter au `start()`.

```typescript
// src/main.ts
import { App } from "@spinejs/core";
import { AppModule } from "./modules/app.module";

const app = new App([AppModule]);

await app.init(); // construit le graphe, enregistre les routes
await app.start(); // écoute
```

`SIGINT`/`SIGTERM` arrêtent l'app proprement — `onStop()` s'exécute en ordre inverse, pas de `process.exit()` nécessaire.

## 2. Le module racine — `modules/app.module.ts`

`AppModule` est de la simple composition : il importe le transport HTTP (configuré une fois) et votre feature-module. Ajoutez d'autres feature-modules à `imports` à mesure que l'app grandit.

```typescript
// src/modules/app.module.ts
import { Module } from "@spinejs/core";
import { HttpGatewayModule } from "@spinejs/http-gateway";
import { AppContextFactory } from "../app-context";
import { UserModule } from "./user/user.module";

@Module({
  imports: [
    HttpGatewayModule.configure({
      imports: [],
      contextFactory: { value: new AppContextFactory() },
      port: 3000,
    }),
    UserModule,
  ],
})
export class AppModule {}
```

Votre contexte d'app est enregistré **une seule fois** pour devenir le `ctx` par défaut de chaque route (comme l'augmentation d'`Express.Request`). Placez cette augmentation (avec la context factory référencée ci-dessus) dans un fichier partagé :

```typescript
// src/app-context.ts
import type { HttpBaseContext, HttpRaw } from "@spinejs/http-gateway";
import type { ContextFactory } from "@spinejs/gateway-core";

// Partez du contexte de base du transport ; ajoutez session/user ici.
export interface AppContext extends HttpBaseContext {
  user: string;
}

// Enregistre AppContext comme `ctx` par défaut de chaque route (une fois par app).
declare module "@spinejs/http-gateway" {
  interface HttpContextRegistry {
    context: AppContext;
  }
}

// Construit votre contexte depuis la requête Hono brute.
export class AppContextFactory implements ContextFactory<HttpRaw, AppContext> {
  create(raw: HttpRaw): AppContext {
    return { honoCtx: raw, user: raw.req.header("x-user") ?? "anonymous" };
  }
}
```

## 3. Le controller — `modules/user/user.controller.ts`

Chaque route est un **champ d'instance** construit par un helper. Le callback reçoit l'`input` validé et retourne une valeur brute — la gateway l'emballe et la sérialise en JSON.

```typescript
// src/modules/user/user.controller.ts
import { z } from "zod";
import { Controller } from "@spinejs/gateway-core";
import { get, post } from "@spinejs/http-gateway";
import { UserService } from "./user.service";

@Controller({ inject: [UserService] })
export class UserController {
  constructor(private readonly users: UserService) {}

  // GET /users
  list = get("/users", {}, () => this.users.list());

  // POST /users — corps validé, inféré en { name: string }
  create = post(
    "/users",
    { body: z.object({ name: z.string().min(1) }), successStatus: 201 },
    ({ body }) => this.users.create(body.name)
  );
}
```

## 4. Le service — `modules/user/user.service.ts`

Une simple classe, marquée `@Injectable` pour que le conteneur puisse la construire et l'injecter dans le controller.

```typescript
// src/modules/user/user.service.ts
import { Injectable } from "@spinejs/core";

export interface User {
  id: string;
  name: string;
}

@Injectable()
export class UserService {
  private users: User[] = [{ id: "1", name: "Ada" }];

  list() {
    return this.users;
  }

  create(name: string): User {
    const user = { id: String(this.users.length + 1), name };
    this.users.push(user);
    return user;
  }
}
```

## 5. Câbler le feature-module — `modules/user/user.module.ts`

`@HttpModule` lie le controller et ses providers à la gateway. C'est le `UserModule` importé par `AppModule` à l'étape 2.

```typescript
// src/modules/user/user.module.ts
import { HttpModule } from "@spinejs/http-gateway";
import { UserController } from "./user.controller";
import { UserService } from "./user.service";

@HttpModule({
  controllers: [UserController],
  providers: [UserService],
})
export class UserModule {}
```

## 6. Lancer

Démarrez l'app, puis appelez l'API :

```bash
curl localhost:3000/users
# {"ok":true,"data":[{"id":"1","name":"Ada"}]}

curl -X POST localhost:3000/users -H 'content-type: application/json' -d '{"name":"Linus"}'
# {"ok":true,"data":{"id":"2","name":"Linus"}}
```

## Ce que vous venez d'utiliser

| Élément                | Ce qu'il a fait                                                   | En savoir plus                                        |
| ---------------------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
| `App` + lifecycle      | A construit le graphe de modules et exécuté `init → start → stop` | [Cycle de vie](core/lifecycle)                        |
| `@Module` / imports    | A composé le transport et les feature-modules                     | [Modules](core/modules)                               |
| `@Controller` + routes | A déclaré les handlers comme champs typés                         | [Controllers et Routes](gateway/controllers-handlers) |
| `get`/`post` + schémas | A typé et validé l'`input`                                        | [Validation](gateway/validation)                      |
| `@Injectable` / DI     | A construit `UserService` et l'a injecté dans le controller       | [Injection de dépendances](core/dependency-injection) |

## Étapes suivantes

- Ajoutez de l'**auth** avec un [Guard](gateway/guards).
- Ajoutez logging/métriques transverses avec un [Interceptor](gateway/interceptors).
- Comprenez le pipeline de requête dans l'[aperçu Gateway](gateway/overview).
- Réutilisez les mêmes **services et guards** en IPC Electron — voir [Transport IPC Electron](transports/electron-ipc). Les routes sont redéclarées dans le vocabulaire IPC (`handle("channel", …)` au lieu de `get`/`post`).
