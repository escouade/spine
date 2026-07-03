---
sidebar_position: 2
---

# Transport HTTP

`@spinejs/http-gateway` est le binding HTTP de `@spinejs/gateway-core`, bâti sur [Hono](https://hono.dev). Vous écrivez de simples controllers avec des routes typées ; le transport transforme chaque route en un endpoint HTTP actif et sérialise le résultat en JSON.

Commencez par l'usage ci-dessous — la [référence](#référence) en bas couvre les classes et types quand vous en avez besoin.

## Votre premier controller HTTP

Trois petites étapes : enregistrer votre contexte d'app une fois, écrire un controller, l'enregistrer.

### 1. Enregistrer votre contexte d'app

Augmentez le `HttpContextRegistry` **une seule fois** avec votre type de contexte — comme l'augmentation d'`Express.Request`. Il devient le `ctx` par défaut de chaque route au niveau du framework, si bien que les `get`/`post`/… importés depuis `@spinejs/http-gateway` typent `ctx` et infèrent l'`input` de chaque route sans factory par fichier.

```typescript
// app-context.ts
import type { HttpBaseContext } from "@spinejs/http-gateway";

export interface AppContext extends HttpBaseContext {
  user: string; // votre session/user etc.
}

declare module "@spinejs/http-gateway" {
  interface HttpContextRegistry {
    context: AppContext;
  }
}
```

:::caution
Sans cette augmentation, le `ctx` par défaut retombe sur `HttpBaseContext`, donc des champs applicatifs comme `ctx.user` n'existent pas. Déclarez-la **une fois par app** (comme `Express.Request`).
:::

### 2. Écrire le controller

Déclarez chaque route comme un **champ d'instance**. Importez les helpers directement depuis `@spinejs/http-gateway`. Le callback reçoit `(input, ctx)` : `input` est le `{ params, query, body }` validé (seulement les sources pour lesquelles vous avez fourni un schéma), `ctx` vaut par défaut votre `AppContext`. Retournez la charge utile brute — la gateway l'emballe dans une enveloppe et la sérialise.

```typescript
// users.controller.ts
import { z } from "zod";
import { Controller } from "@spinejs/gateway-core";
import { get, post, del } from "@spinejs/http-gateway";
import { UsersStore } from "./users.store";
import { AdminGuard } from "./admin.guard";
import { NotFoundError } from "./not-found.error";

const userSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  role: z.enum(["admin", "member"]),
});
const createUserSchema = userSchema.omit({ id: true });

@Controller({ inject: [UsersStore] })
export class UsersController {
  constructor(private readonly users: UsersStore) {}

  // GET /users?role=admin — query validée, inférée en `{ role?: "admin" | "member" }`
  list = get(
    "/users",
    { query: z.object({ role: z.enum(["admin", "member"]).optional() }) },
    ({ query }) => this.users.list(query.role)
  );

  // GET /users/:id — param de chemin ; throw → mappé vers un code stable par l'ErrorMapper
  getById = get(
    "/users/:id",
    { params: z.object({ id: z.string().uuid() }) },
    ({ params }) => {
      const user = this.users.get(params.id);
      if (!user) throw new NotFoundError(`User ${params.id} not found`);
      return user;
    }
  );

  // POST /users — corps JSON, 201 en cas de succès
  create = post(
    "/users",
    { body: createUserSchema, successStatus: 201 },
    ({ body }) => this.users.create(body)
  );

  // DELETE /users/:id — gardé par route via AdminGuard
  remove = del(
    "/users/:id",
    { params: z.object({ id: z.string().uuid() }), guards: [AdminGuard] },
    ({ params }) => ({ deleted: this.users.delete(params.id) })
  );
}
```

### 3. L'enregistrer

Liez le controller à la gateway avec le sucre de feature-module — forme décorateur `@HttpModule` (classe nommée) ou forme factory `httpFeature({ … })` — et ajoutez `HttpGatewayModule.configure({ … })` quelque part dans le graphe.

```typescript
// app.module.ts — la composition root
import type { ModuleEntry } from "@spinejs/core";
import { HttpGatewayModule, HttpModule } from "@spinejs/http-gateway";
import { AppContextFactory } from "./app-context";
import { AppErrorMapper, appStatusMapper } from "./app-error.mapper";
import { UsersController } from "./users.controller";
import { UsersStore } from "./users.store";

@HttpModule({
  controllers: [UsersController],
  providers: [UsersStore],
})
export class UsersModule {}

export const modules: ModuleEntry[] = [
  HttpGatewayModule.configure({
    imports: [],
    contextFactory: { value: new AppContextFactory() },
    errorMapper: { value: new AppErrorMapper() },
    statusMapper: { value: appStatusMapper },
    // port: 3000, // décommentez pour écouter automatiquement (App#start() appelle gateway.listen())
  }),
  UsersModule,
];
```

Voilà une API HTTP fonctionnelle. `App#start()` écoute automatiquement quand `port` est défini ; sinon, montez l'`app` Hono de la gateway derrière votre propre serveur. Voir [Feature Modules](../gateway/feature-modules) pour les formes décorateur/factory et [Controllers et Routes](../gateway/controllers-handlers) pour l'ensemble des options de route (`response`, `guards` par route, `successStatus`).

## Comment l'input parvient à votre handler

Quel que soit le verbe, le transport remet au pipeline un objet structuré `{ params, query, body }` :

- `params` — les params de chemin (`/users/:id`).
- `query` — la query string parsée.
- `body` — le JSON parsé pour les méthodes à corps (`POST`/`PUT`/`PATCH`), `undefined` sinon (un corps malformé retombe aussi sur `undefined`).

Les schémas par source de votre route (`{ params }`, `{ query }`, `{ body }`) valident cet objet source par source. Chaque callback reçoit alors l'`input` restreint — seules les sources pour lesquelles vous avez déclaré un schéma apparaissent, chacune typée par la sortie de son schéma. Voir [Controllers et Routes](../gateway/controllers-handlers).

### Pourquoi les helpers sont un appel de fonction, pas un décorateur

`get`/`post`/… ne sont **pas** du sucre de typage cosmétique — chaque appel fait un vrai travail : il construit le `RouteMarker` de la route, compose les schémas par source dans le validateur d'input, lie la méthode HTTP + le chemin, et porte `guards`/`successStatus`/`response` en meta. `getRoutes` récupère ensuite ces markers sur les champs d'instance du controller à l'enregistrement. Une route **doit** donc passer par un helper (ou un `RouteMarker` construit à la main) pour exister.

Leur second rôle est le typage. L'augmentation unique du `HttpContextRegistry` fixe le `ctx` par défaut, si bien que l'`input` de chaque route est **inféré** depuis ses schémas et que `ctx` est typé sans annotation. Une forme décorateur ne peut pas inférer les types des paramètres du callback ainsi sous le build du projet (décorateurs stage-3 / esbuild) — la forme appel de fonction est donc le mécanisme, pas une préférence. Omettez `ctx` quand une route n'y touche pas. Une route peut se désolidariser du contexte d'app en annotant son `ctx` (ex. `(_input, ctx: HttpBaseContext) => …`) ; l'annotation surcharge le défaut pour cette route uniquement.

## Envelopper chaque requête : middleware & CORS

La gateway n'enveloppe **pas** CORS, logging, compression, en-têtes d'auth, etc. — c'est le rôle de Hono, et `app` est exposé précisément pour que vous montiez vous-même les [middlewares Hono](https://hono.dev/docs/middleware/builtin/cors). Aucune API spécifique à SpineJS à apprendre ; tout ce qui vient de `hono/*` fonctionne.

Pour attacher un middleware, construisez vous-même le `HttpGateway` dans votre composition root et passez-le à `configure({ gateway })`. La gateway pré-construite porte déjà ses ports (context factory, error mapper, status mapper), vous ne les passez donc plus à `configure` :

```typescript
// app.module.ts — la composition root
import type { ModuleEntry } from "@spinejs/core";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import {
  HttpGateway,
  HttpGatewayModule,
  ZodValidator,
} from "@spinejs/http-gateway";
import { AppContextFactory } from "./app-context";
import { AppErrorMapper, appStatusMapper } from "./app-error.mapper";
import { UsersModule } from "./users.module";

// La gateway possède désormais ses ports (c'étaient les adaptateurs de `configure` avant).
const gateway = new HttpGateway(
  new ZodValidator(),
  new AppErrorMapper(),
  new AppContextFactory(),
  [],
  appStatusMapper
);

// Montez le middleware sur l'app Hono brute AVANT l'enregistrement.
gateway.app.use("*", cors({ origin: "https://app.example.com" }));
gateway.app.use("*", logger());

export const modules: ModuleEntry[] = [
  HttpGatewayModule.configure({ imports: [], gateway: { value: gateway } }),
  UsersModule,
];
```

**L'ordre compte.** Hono associe middlewares et routes dans l'ordre d'enregistrement, le middleware doit donc être attaché **avant** les routes qu'il doit envelopper. Les routes sont montées durant l'`onInit` du feature-module (`register` → `app.on(...)`), c.-à-d. après la construction de la gateway — ajouter `app.use(...)` sur une gateway pré-construite (comme ci-dessus) est donc toujours assez tôt. Ajouter un middleware _après_ `app.init()` raterait les routes déjà enregistrées.

## Personnaliser le pipeline

Les trois ports sont votre moyen d'injecter les préoccupations applicatives (contexte, codes d'erreur, statut) sans que le transport les connaisse. Vous les passez via `HttpGatewayModule.configure()`.

### `ContextFactory` — enrichir le contexte

```typescript
import type { ContextFactory } from "@spinejs/gateway-core";
import type { HttpBaseContext, HttpRaw } from "@spinejs/http-gateway";

export type AppContext = HttpBaseContext; // étendez avec session/user au besoin

export class AppContextFactory implements ContextFactory<HttpRaw, AppContext> {
  create(raw: HttpRaw): AppContext {
    return { honoCtx: raw };
  }
}
```

### `ErrorMapper` + status mapper

L'`ErrorMapper` convertit toute erreur lancée en un **code** stable et agnostique du transport ; le **status mapper** transforme ce code en statut HTTP. Cette séparation garde le code réutilisable entre transports tandis que le statut reste spécifique à HTTP. Étendez le défaut pour ajouter vos propres codes :

```typescript
import type { ErrorMapper } from "@spinejs/gateway-core";
import { ValidationError, UnauthorizedError } from "@spinejs/gateway-core";
import { NotFoundError } from "./not-found.error";

export type AppErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

export class AppErrorMapper implements ErrorMapper<AppErrorCode> {
  toCode(err: unknown): AppErrorCode {
    if (err instanceof NotFoundError) return "NOT_FOUND";
    if (err instanceof ValidationError) return "BAD_REQUEST";
    if (err instanceof UnauthorizedError) return "UNAUTHORIZED";
    return "INTERNAL_ERROR";
  }
}

const statusByCode: Record<AppErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
};
export const appStatusMapper = (code: string): number =>
  statusByCode[code as AppErrorCode] ?? 500;
```

Sans `statusMapper`, un défaut intégré couvre les codes courants : `BAD_REQUEST` → 400, `UNAUTHORIZED` → 401, `FORBIDDEN` → 403, `NOT_FOUND` → 404, `CONFLICT` → 409, `UNPROCESSABLE` → 422, `TOO_MANY_REQUESTS` → 429, `INTERNAL_ERROR` → 500, `SERVICE_UNAVAILABLE` → 503 ; tout code inconnu retombe sur 500. Un `ErrorMapper` custom qui émet ces codes obtient donc le bon statut **sans** fournir de `statusMapper` — n'en fournissez un que pour des codes non standard.

### Options de `configure()`

`configure()` fournit les adaptateurs de l'app ; chacun accepte un `ProviderAdapter` (`{ value }` ou un DI `{ inject?, factory }`).

| Option           | Requis | Défaut                                    | Description                                                                                                                                                                                        |
| ---------------- | ------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `imports`        | Oui    | —                                         | Modules dont les adaptateurs (p. ex. les deps de la context factory) ont besoin des exports.                                                                                                       |
| `contextFactory` | Oui\*  | —                                         | Construit le contexte d'app depuis le contexte Hono. \*Pas requis quand une `gateway` pré-construite est fournie.                                                                                  |
| `errorMapper`    | Non    | `DefaultHttpErrorMapper`                  | Mappe les erreurs lancées vers des codes stables.                                                                                                                                                  |
| `validator`      | Non    | `ZodValidator`                            | Valide l'input structuré ; lance `ValidationError`.                                                                                                                                                |
| `interceptors`   | Non    | `[]`                                      | Wrappers transverses autour de chaque dispatch — voir [Interceptors](../gateway/interceptors).                                                                                                     |
| `statusMapper`   | Non    | Codes courants → statuts (voir ci-dessus) | Mappe un code d'erreur vers un statut HTTP.                                                                                                                                                        |
| `port`           | Non    | `undefined` (pas d'écoute auto)           | Quand défini, `onStart()` appelle `gateway.listen(port)`.                                                                                                                                          |
| `gateway`        | Non    | construite depuis les adaptateurs         | Une `HttpGateway` pré-construite (ou factory). Remplace le défaut ; permet à un test de tenir l'instance et de piloter `gateway.app.request()`. Quand fournie, `contextFactory` n'est pas requise. |

## Tester sans vrai port

Passez une gateway pré-construite via `configure({ gateway })` et pilotez directement le `app.request()` de Hono — pas de socket, pas de `listen()` :

```typescript
const gateway = new HttpGateway(
  new ZodValidator(),
  new AppErrorMapper(),
  new AppContextFactory(),
  [],
  appStatusMapper
);

const app = new App([
  HttpGatewayModule.configure({ imports: [], gateway: { value: gateway } }),
  UsersModule,
]);
await app.init();

const res = await gateway.app.request("/users?role=admin");
expect(res.status).toBe(200);
expect((await res.json()).data).toHaveLength(1);
```

## Référence

### `HttpGateway`

```typescript
class HttpGateway<
  Ctx extends HttpBaseContext = HttpBaseContext,
  Code extends string = string,
>
```

La gateway **compose** un `DispatchPipeline` (elle n'étend pas de classe de base) et possède `register`/`bind`. Elle est agnostique de l'application : elle ne connaît que le contexte Hono ; les préoccupations applicatives (session, user…) sont injectées via le port `ContextFactory`.

`bind()` monte chaque route avec `app.on(method, path, …)`. Au dispatch, elle construit le contexte depuis le contexte Hono brut, extrait l'input structuré, exécute le pipeline, et retourne une `Response` JSON dont le statut est le `successStatus` de la route (défaut `200`) en cas de succès, ou `statusMapper(code)` en cas d'échec.

#### Constructeur

```typescript
new HttpGateway(
  validator: Validator,
  errorMapper: ErrorMapper<Code>,
  contextFactory: ContextFactory<HttpRaw, Ctx>,
  interceptors?: GatewayInterceptor<Ctx, Code>[],
  statusMapper?: (code: Code) => number,
)
```

#### Surface exposée

- **`app`** — l'app Hono sous-jacente. Pilotez-la directement dans les tests avec `gateway.app.request(path, init)`, ou montez-la derrière votre propre serveur / middleware.
- **`listen(port)`** — un raccourci qui démarre un serveur Node (`@hono/node-server`). Appelé par l'`onStart()` du module quand `configure({ port })` est défini.

#### Types

```typescript
interface HttpAddress {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
}
type HttpMethod = HttpAddress["method"];

// Contexte au niveau transport — agnostique de l'app ; l'app l'étend via sa ContextFactory.
interface HttpBaseContext extends GatewayContext {
  honoCtx: Context; // le Context de hono
}

// Données brutes de l'appel remises à la ContextFactory : le contexte de requête Hono.
type HttpRaw = Context;
```
