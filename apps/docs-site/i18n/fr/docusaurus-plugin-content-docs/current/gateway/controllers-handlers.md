---
sidebar_position: 2
---

# Contrôleurs et routes

Les contrôleurs regroupent la logique de traitement des messages entrants. On les déclare avec `@Controller` et on expose chaque route comme **champ d'instance** construit par les helpers de routes typés d'un transport (`get`/`post`/… pour HTTP, `handle` pour IPC).

:::tip
Pour un parcours de bout en bout (service → controller → serveur qui tourne), commencez par [Prise en main](../getting-started). Cette page est la référence complète pour déclarer controllers et routes.
:::

:::info Routes en champ (field-form)
Les routes sont déclarées comme **champs**, pas comme méthodes décorées. Un helper de champ (`get(...)`, `handle(...)`, …) est un appel de fonction : il peut donc **inférer** le type d'`input` du handler depuis le schéma zod de la route — une seule source de vérité, vérifiée à la compilation, sans `reflect-metadata`. Voir l'ADR 0004 (`docs/adr/0004-field-form-routes.md`) pour la justification. L'ancien décorateur de méthode `@Handler` a été supprimé.
:::

## `@Controller()`

`@Controller` marque une classe comme contrôleur de gateway **et** intègre `@Injectable` : le même décorateur déclare la classe comme provider DI avec ses dépendances de constructeur typées.

```typescript
import { Controller } from "@spinejs/gateway-core";

@Controller({ inject: [UsersStore] })
export class UsersController {
  constructor(private readonly users: UsersStore) {}
  // routes en champs…
}
```

`inject` est typé exactement comme `@Injectable` — un token de mauvais type, ordre ou arité est une erreur de compilation. Un `@Controller()` nu (sans dépendance) est aussi valide. Une classe contrôleur doit figurer dans le tableau `controllers` d'un feature module (voir [Feature Modules](./feature-modules)) ; la gateway résout les instances via DI.

## Déclarer des routes avec un helper

Chaque transport exporte des helpers de routes au niveau du framework que vous importez directement. Le `ctx` de leur callback vaut par défaut votre **contexte d'app**, que vous enregistrez **une seule fois** via une augmentation `declare module` (comme `Express.Request`) :

```typescript
// app-context.ts
import type { HttpBaseContext } from "@spinejs/http-gateway";

export interface AppContext extends HttpBaseContext {
  user: string;
}

// Enregistre AppContext comme `ctx` par défaut de chaque route (une fois par app).
declare module "@spinejs/http-gateway" {
  interface HttpContextRegistry {
    context: AppContext;
  }
}
```

:::caution
Sans cette augmentation, le `ctx` par défaut retombe sur le contexte de base du transport (`HttpBaseContext` / `ElectronIpcBaseContext`), donc des champs applicatifs comme `ctx.user` n'existent pas. Déclarez-la une fois par app.
:::

Puis importez les helpers depuis le paquet du transport et déclarez les routes comme champs. Le callback prend l'**`input` validé d'abord** et le **`ctx` en dernier**, tous deux typés sans annotation :

```typescript
import { z } from "zod";
import { Controller } from "@spinejs/gateway-core";
import { get, post } from "@spinejs/http-gateway";

const listQuery = z.object({ role: z.enum(["admin", "member"]).optional() });
const createBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});

@Controller({ inject: [UsersStore] })
export class UsersController {
  constructor(private readonly users: UsersStore) {}

  // GET /users?role=admin — `query` est inféré comme { role?: "admin" | "member" }
  list = get("/users", { query: listQuery }, ({ query }) =>
    this.users.list(query.role)
  );

  // POST /users — `body` inféré ; 201 en cas de succès
  create = post(
    "/users",
    { body: createBody, successStatus: 201 },
    ({ body }) => this.users.create(body)
  );
}
```

- **`input`** est l'entrée validée, découpée par source pour HTTP (`{ params, query, body }` — seules apparaissent les sources pour lesquelles vous avez déclaré un schéma). Chaque clé est typée par la sortie inférée de son schéma.
- **`ctx`** est le contexte de transport, par défaut votre contexte d'app enregistré. Une route qui l'ignore écrit `(input) => …` ; une route qui en a besoin écrit `(input, ctx) => …`. Pour désolidariser une route du contexte d'app, annotez son `ctx` (ex. `(_input, ctx: HttpBaseContext) => …`) — l'annotation surcharge le défaut pour cette route uniquement.

Comme les helpers sont des champs initialisés dans la portée du constructeur, `this` (et donc les services injectés comme `this.users`) est disponible dans le callback.

## Options de route

Le second argument est l'objet d'**options** de la route. Pour HTTP :

| Option          | Type                       | Description                                                                              |
| --------------- | -------------------------- | ---------------------------------------------------------------------------------------- |
| `params`        | `ParseableSchema<P>`       | Schéma des params de chemin (`/users/:id`). Présent ⇒ `input.params` est validé et typé. |
| `query`         | `ParseableSchema<Q>`       | Schéma de la query string. Présent ⇒ `input.query` est validé et typé.                   |
| `body`          | `ParseableSchema<B>`       | Schéma du corps JSON (POST/PUT/PATCH). Présent ⇒ `input.body` est validé et typé.        |
| `response`      | `ParseableSchema<unknown>` | Réservé à la génération OpenAPI — porté dans le `meta` du marker, **jamais** validé.     |
| `guards`        | `GuardConstructor[]`       | Guards par route, fusionnés après le `@UseGuards` de classe. Voir [Guards](./guards).    |
| `successStatus` | `number`                   | Statut HTTP pour une enveloppe en succès. Défaut `200` (ex. `201` pour une création).    |
| `headers`       | `Record<string, string>`   | En-têtes de réponse statiques ajoutés en succès. Écrasent le `Content-Type` par défaut.  |

Les routes IPC (`handle`) prennent un unique schéma `input` au lieu des sources découpées (un appel IPC porte une seule charge utile), plus les mêmes `response` et `guards`.

## Validation d'entrée avec `ParseableSchema<T>`

Un schéma est tout objet exposant une méthode `parse(input: unknown): T` — le contrat structurel que zod satisfait, si bien que la lib gateway infère vos types **sans importer zod**. HTTP compose les schémas par source (`params`/`query`/`body`) en un seul validateur sur l'entrée structurée ; chaque source est validée indépendamment.

En cas d'échec, le port `Validator` (ex. `ZodValidator`) lève une `ValidationError`, que le pipeline mappe vers votre code `BAD_REQUEST` (HTTP 400 par défaut). Le callback du handler n'est jamais appelé.

:::note Inférence de schéma
Le type d'`input` du handler découle de l'objet de schémas passé au site d'appel. Omettez une source et sa clé disparaît entièrement d'`input` ; fournissez-la et la clé est typée par le type de retour de `parse`. Aucune annotation explicite sur le paramètre du callback.
:::

## Valeurs de retour

Un handler peut renvoyer une valeur simple ou une `Promise`. Le pipeline enveloppe la valeur résolue dans `{ ok: true, data: value }`. Lever une erreur (ou renvoyer une promesse rejetée) renvoie `{ ok: false, code: <code mappé> }` — l'erreur est mappée par l'`ErrorMapper` du transport.

```typescript
getVersion = get("/version", {}, () => "1.0.0");
// → { ok: true, data: "1.0.0" }

load = get("/data", {}, async () => await fetchData());
// → { ok: true, data: {...} }  ou  { ok: false, code: "INTERNAL_ERROR" }
```
