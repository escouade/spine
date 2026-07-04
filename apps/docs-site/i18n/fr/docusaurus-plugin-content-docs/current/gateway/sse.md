---
sidebar_position: 7
---

# Server-Sent Events (SSE)

Les Server-Sent Events poussent un **flux** d'événements du serveur vers le client sur une seule
connexion HTTP longue durée (`text/event-stream`, l'`EventSource` natif du navigateur). SpineJS fournit
deux briques :

- **`sse()`** — un marqueur de route pour un `GET` en streaming, jumeau de
  [`get`/`post`](./controllers-handlers). Sa callback renvoie un `AsyncIterable<SseEvent>` au lieu d'une
  seule valeur.
- **`SseHub`** — un hub de **fan-out** clé en main, pour qu'un événement côté serveur atteigne **chaque**
  connexion ouverte d'un sujet (par ex. tous les onglets d'un utilisateur).

Les deux vivent dans `@spinejs/http-gateway` — le SSE est spécifique à HTTP.

## Une route en streaming

Écrivez l'endpoint comme n'importe quelle route, mais renvoyez un flux. Le cas typique est le _fan-out_ :
un contrôleur abonne chaque connexion à un hub indexé par un sujet ; un événement côté serveur atteint
alors chaque abonné ouvert. Suivez l'ordre naturel — la route, puis le hub, puis celui qui publie.

```typescript
// jobs.controller.ts — l'endpoint en streaming
import { Controller } from "@spinejs/gateway-core";
import { sse } from "@spinejs/http-gateway";
import { JobsHub } from "./jobs.hub";

@Controller({ inject: [JobsHub] })
export class JobsController {
  constructor(private readonly jobs: JobsHub) {}

  // GET /jobs/stream → text/event-stream, une connexion ouverte par session
  stream = sse("/jobs/stream", {}, (_input, ctx) =>
    this.jobs.subscribe(ctx.user)
  );
  //                                                 ^ renvoie AsyncIterable<SseEvent>
}
```

```typescript
// jobs.hub.ts — le fan-out ; le code serveur appelle publish()
import { Injectable } from "@spinejs/core";
import { SseHub } from "@spinejs/http-gateway";

@Injectable()
export class JobsHub {
  private readonly hub = new SseHub<string>(); // indexé par userId

  subscribe(userId: string) {
    return this.hub.subscribe(userId); // AsyncIterable<SseEvent>
  }

  // appelé partout où un job change (ex. un pont Postgres LISTEN/NOTIFY) → diffuse à tous les onglets de l'utilisateur
  onJobWrite(userId: string, job: { id: string; status: string }) {
    this.hub.publish(userId, { event: job.status, data: job });
  }
}
```

Voilà toute la surface : **`sse()`** déclare l'endpoint, **`SseHub`** diffuse. Un `GET /jobs/stream` qui
diffuse `job.created / updated / completed` à chacune des sessions ouvertes d'un assigné tient en ~15
lignes.

Un `SseEvent` correspond aux champs du protocole SSE :

```typescript
interface SseEvent {
  data: unknown; // sérialisé en JSON dans le champ `data:` (une string est envoyée telle quelle)
  event?: string; // le nom d'`event:` (le `addEventListener(name, …)` du client)
  id?: string; // le champ `id:` — remonte en `Last-Event-ID` à la reconnexion
  retry?: number; // indice de backoff de reconnexion (ms)
}
```

Côté client, c'est l'API standard du navigateur — pas de client SpineJS :

```typescript
const es = new EventSource("/jobs/stream");
es.addEventListener("completed", (e) => console.log(JSON.parse(e.data)));
```

## Faire

### Protéger un flux

Un flux est authentifié **une fois, à l'ouverture**. Passez `guards` comme pour une route normale — ils
s'exécutent avant tout streaming, et un refus renvoie une erreur JSON normale (jamais un flux à moitié
ouvert) :

```typescript
stream = sse("/jobs/stream", { guards: [AuthGuard] }, (_input, ctx) =>
  this.jobs.subscribe(ctx.user)
);
```

### Valider `params` / `query`

`sse()` valide `params` et `query` comme n'importe quelle route (c'est un `GET`, donc pas de `body`).
L'`input` inféré arrive à la callback de la même façon :

```typescript
stream = sse(
  "/rooms/:id/stream",
  { params: z.object({ id: z.string().uuid() }) },
  ({ params }, ctx) => this.rooms.subscribe(params.id, ctx.user)
);
```

### Streamer sans hub

Le handler doit seulement renvoyer un `AsyncIterable<SseEvent>` — un générateur async convient quand il
n'y a pas de fan-out, juste un flux par connexion :

```typescript
ticks = sse("/clock", {}, async function* () {
  for (;;) {
    yield { event: "tick", data: { at: new Date().toISOString() } };
    await new Promise((r) => setTimeout(r, 1000));
  }
});
```

### Régler le heartbeat

Le transport écrit un commentaire `: ping` sur une connexion inactive pour que les proxys ne la coupent
pas. L'intervalle est `sseHeartbeatMs` sur le module HTTP (défaut `15_000` ; `0` le désactive) :

```typescript
HttpGatewayModule.configure({
  imports: [],
  contextFactory: { value: new AppContextFactory() },
  sseHeartbeatMs: 30_000,
});
```

### Contre-pression (backpressure)

Un client lent ne peut pas faire croître la mémoire du serveur sans limite. Chaque abonné a une file
bornée (`maxQueuePerSubscriber`, défaut `1000`) ; au-delà du plafond, l'événement le **plus ancien** est
supprimé. Le SSE est un réveil best-effort — le client se resynchronise à la reconnexion — donc jeter les
vieux événements vaut mieux qu'un buffer non borné :

```typescript
private readonly hub = new SseHub<string>({ maxQueuePerSubscriber: 200 });
```

### La déconnexion est automatique

Quand le client ferme la connexion, le transport appelle le `return()` de l'itérateur, qui se désabonne
du hub et supprime la clé vide — aucun abonnement fuité, rien à nettoyer à la main.

:::caution Une route SSE contourne les interceptors et la portée CLS
Contrairement à une route bufferisée, une connexion SSE n'exécute **aucune** chaîne d'interceptors et
n'ouvre **aucune** portée [CLS](../extensions/cls) par requête. Une portée CLS encadre une courte unité
de travail et libère ses ressources scopées (une transaction DB, un store) à la fin ; un flux vit des
minutes ou des heures, donc en garder une ouverte pendant toute sa vie serait une fuite. Le handler reçoit
`ctx` **directement** et lit ce dont il a besoin à l'ouverture. Produire les données diffusées est le
travail de l'écrivain côté `POST`, dans sa propre portée de requête — l'endpoint SSE se contente de les
rediffuser.
:::

## Référence

### `sse(path, options, handler)`

Une fonction de route au niveau module (importée depuis `@spinejs/http-gateway`), déclarée comme champ
d'instance de contrôleur. Toujours `GET`. `handler: (input, ctx) => AsyncIterable<SseEvent>` ; `input` est
inféré depuis `params`/`query`, `ctx` a pour défaut le contexte d'app enregistré (voir [Contrôleurs et
routes](./controllers-handlers)).

`SseRouteOptions` (le second argument) :

| Option    | Type                     | Description                                                               |
| --------- | ------------------------ | ------------------------------------------------------------------------- |
| `params`  | `ParseableSchema<P>`     | Schéma des params de chemin. Présent → `input.params` est validé.         |
| `query`   | `ParseableSchema<Q>`     | Schéma de la query string. Présent → `input.query` est validé.            |
| `guards`  | `GuardConstructor[]`     | Guards par route ; exécutés une fois à l'ouverture, avant tout streaming. |
| `headers` | `Record<string, string>` | En-têtes statiques ajoutés à la réponse `text/event-stream`.              |

Pas de `body`, `successStatus` ni `response` — le flux possède la réponse.

### `SseHub<K = string>`

Un fan-out en mémoire indexé par `K` (les événements sont toujours des `SseEvent`, donc seule la clé est
générique).

| Membre                                    | Description                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `new SseHub(options?)`                    | `options: SseHubOptions`.                                                    |
| `subscribe(key): AsyncIterable<SseEvent>` | Ouvre un flux pour `key` ; itérez avec `for await`. Sortir/return désabonne. |
| `publish(key, event): void`               | Pousse `event` à chaque abonné ouvert sur `key`. No-op s'il n'y en a aucun.  |
| `subscriberCount(key): number`            | Nombre d'abonnés vivants sur `key` (introspection / tests).                  |
| `close(): void`                           | Termine le flux de chaque abonné (par ex. à l'arrêt).                        |

`SseHubOptions` :

| Option                  | Type     | Défaut | Description                                                                       |
| ----------------------- | -------- | ------ | --------------------------------------------------------------------------------- |
| `maxQueuePerSubscriber` | `number` | `1000` | Nb max d'événements bufferisés pour un abonné lent avant de jeter le plus ancien. |

### `SseEvent`

| Champ   | Type      | Description                                                           |
| ------- | --------- | --------------------------------------------------------------------- |
| `data`  | `unknown` | Sérialisé en JSON dans `data:` (une string est envoyée telle quelle). |
| `event` | `string?` | Le nom d'`event:` (défaut `message` du navigateur).                   |
| `id`    | `string?` | Le champ `id:` ; remonte en `Last-Event-ID` à la reconnexion.         |
| `retry` | `number?` | Indice de backoff de reconnexion (ms).                                |

### Configuration du heartbeat

`HttpGatewayModule.configure({ sseHeartbeatMs })` — intervalle du commentaire keep-alive (défaut `15_000`,
`0` le désactive). Voir la page [Transport HTTP](../transports/http) pour toute la surface de
`configure()`.

Le raisonnement de conception (pourquoi le SSE est intégré à `http-gateway` et contourne
l'enveloppe/les interceptors/le CLS) est consigné dans l'ADR 0017
(`docs/adr/0017-sse-fan-out-in-http-gateway.md`).
