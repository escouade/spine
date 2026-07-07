---
sidebar_position: 6
---

# Throttle (limitation de débit)

`@spinejs/throttle` écarte le trafic abusif avec des politiques à **fenêtre glissante exacte**,
appliquées comme un intercepteur de gateway. Une politique signifie exactement ce qu'elle dit — _au plus
`limit` requêtes acceptées par clé par `windowMs`_ — donc pas de token bucket approximatif à raisonner.
C'est **désactivé par défaut** : sans configuration, aucun intercepteur dans la chaîne et zéro surcoût.
Le cœur est indépendant du transport ; les presets `./http` et `./electron-ipc` ajoutent les sources de
clé (adresse / renderer) et, pour HTTP, les en-têtes standard `RateLimit-*`.

## Protéger une route de login

La limitation de débit est un intercepteur placé **en premier** (le plus externe) dans les
`interceptors` d'une gateway. Configurez les politiques, câblez le token de l'intercepteur, et déclarez
la protection par route à côté de la route :

```typescript
// src/main.ts
import { App } from "@spinejs/core";
import { AppModule } from "./app.module";

await new App([AppModule]).start();
```

```typescript
// src/app.module.ts
import { Module } from "@spinejs/core";
import { HttpGatewayModule, httpFeature } from "@spinejs/http-gateway";
import { ThrottleModule, throttleInterceptorRef } from "@spinejs/throttle";
import { throttleHttp } from "@spinejs/throttle/http";
import { AuthController } from "./auth.controller";

@Module({
  imports: [
    // 1. Déclarer les politiques. `throttleHttp()` câble la source de clé `'ip'` ET active les
    //    en-têtes draft-6 `RateLimit-*` + `Retry-After` (la présentation vit sur `./http`).
    ThrottleModule.configure({
      policies: {
        global: { limit: 100, windowMs: 60_000, keyBy: "ip", scope: "gateway" },
      },
      ...throttleHttp(),
    }),
    // 2. Placer l'intercepteur EN PREMIER dans la gateway (le plus externe — les requêtes rejetées
    //    sont peu coûteuses).
    HttpGatewayModule.configure({
      imports: [
        /* votre module de context-factory */
      ],
      contextFactory: {
        /* ... */
      },
      interceptors: {
        inject: [throttleInterceptorRef()],
        factory: (throttle) => [throttle],
      },
    }),
    httpFeature({ controllers: [AuthController] }),
  ],
})
export class AppModule {}
```

```typescript
// src/auth.controller.ts
import { Controller } from "@spinejs/gateway-core";
import { post } from "@spinejs/http-gateway";
import "@spinejs/throttle/http"; // rend `throttle` typé dans les options de route

@Controller({})
export class AuthController {
  // Une politique route-inline vit à côté de la route qu'elle protège : 5 tentatives / 15 min par adresse.
  login = post(
    "/login",
    { throttle: { policies: [{ limit: 5, windowMs: 900_000, keyBy: "ip" }] } },
    ({ body }) => this.auth.login(body)
  );
}
```

Au-delà de la limite, la requête échoue avec `429 Too Many Requests` **avant** tout guard, validation ou
handler, en portant `Retry-After` et les en-têtes draft-6 `RateLimit-Limit` / `-Remaining` / `-Reset`.
La politique de gateway `global` et la politique route-inline `login` sont évaluées indépendamment :
l'épuisement de l'une ou l'autre rejette la requête.

:::info 429 avant 400
L'application est l'intercepteur **le plus externe**, donc il s'exécute avant la validation. Une requête
au-delà de la limite qui est _aussi_ malformée reçoit un `429`, pas un `400` — l'abus est écarté avant
tout travail, valide ou non.
:::

## Faire

### Un quota global de gateway

Une politique `scope: 'gateway'` partage **un seul bucket par clé sur toutes les routes** — le quota à
l'échelle de l'app. Elle est déclarable uniquement dans `configure` (jamais route-inline) :

```typescript
ThrottleModule.configure({
  policies: {
    global: { limit: 100, windowMs: 60_000, keyBy: "ip", scope: "gateway" },
  },
  ...throttleHttp(),
});
```

Une politique par défaut _sans_ `scope: 'gateway'` est `scope: 'route'` — un bucket par clé **par cible
de route**, donc `/a` et `/b` comptent séparément sous le même défaut nommé.

### Politiques par route, skip et opt-out

Chaque helper de route — verbes HTTP, `sse()`, et `handle()` IPC — accepte la même option `throttle` :

```typescript
// Ajouter des politiques route-inline (scopées `routeId#index`, non surchargeables) :
post(
  "/login",
  { throttle: { policies: [{ limit: 5, windowMs: 900_000, keyBy: "ip" }] } },
  fn
);

// Désactiver UN défaut nommé de gateway pour cette route :
get("/health", { throttle: { skip: ["global"] } }, fn);

// Réajuster un défaut nommé pour cette route seulement :
get("/report", { throttle: { override: { global: { limit: 10 } } } }, fn);

// Se désengager de TOUS les défauts :
get("/status", { throttle: false }, fn);
```

Le helper copie vos champs **verbatim** dans `meta.throttle` et estampille un champ — `routeId`
(`"METHOD /path"` pour HTTP, la chaîne du canal pour IPC). Le transport ne l'interprète jamais ; seul
l'intercepteur throttle lit la clé.

### Politiques IPC par canal

Le helper `handle()` IPC a la même option — parité complète avec les routes HTTP. Importez le preset
pour que `throttle` soit typé, et clef par le renderer (`'sender'`) :

```typescript
// src/api.controller.ts
import { Controller } from "@spinejs/gateway-core";
import { handle } from "@spinejs/electron-ipc-gateway";
import "@spinejs/throttle/electron-ipc"; // rend `throttle` typé dans les options de handle()

@Controller({})
export class ApiController {
  sync = handle(
    "data:sync",
    {
      throttle: {
        policies: [{ limit: 10, windowMs: 60_000, keyBy: "sender" }],
      },
    },
    ({ payload }) => this.data.sync(payload)
  );
}
```

Câblez la source de clé comme pour HTTP, sans la présentation des en-têtes :

```typescript
ThrottleModule.configure({
  policies: {
    /* défauts de gateway optionnels */
  },
  keySources: { sender: senderKeySource() }, // depuis @spinejs/throttle/electron-ipc
});
```

`keyBy: 'ip'` sur le transport IPC est une **erreur au boot** — un appel IPC n'a pas d'adresse. Utilisez
`'sender'`.

### Le contrat de rejet IPC

Au-delà de la limite, un appel IPC résout vers une enveloppe d'échec — un **contrat public stable** que
vous mappez dans l'union d'erreurs de votre app :

```typescript
{ ok: false, code: "TOO_MANY_REQUESTS", meta: { retryAfterMs: 1000 } }
```

`code` vaut toujours `"TOO_MANY_REQUESTS"` ; `meta.retryAfterMs` est le délai relatif (ms) après lequel
le client peut réessayer. Étendez l'union de codes d'erreur de votre app avec un code throttle
réessayable et implémentez un vrai backoff plutôt que de deviner :

```typescript
// src/renderer/errors.ts — étendre une union d'erreurs existante (style `CommandErrorCode` du studio)
export type CommandErrorCode = "VALIDATION" | "NOT_FOUND" | "TOO_MANY_REQUESTS";

async function callWithBackoff<T>(
  invoke: () => Promise<Envelope<T>>
): Promise<T> {
  for (;;) {
    const res = await invoke();
    if (res.ok) return res.data;
    if (res.code !== "TOO_MANY_REQUESTS") throw new AppError(res.code);
    // Respecter l'indice du serveur exactement — une attente de `retryAfterMs` libère la fenêtre.
    await sleep(res.meta?.retryAfterMs ?? 1000);
  }
}
```

### Clés personnalisées et le contournement null-skip

`keyBy` peut être une fonction `(ctx, rawInput) => string | null`. Elle reçoit l'**entrée brute avant
validation** ; retourner `null` ignore la politique pour cette requête :

```typescript
// Limiter les utilisateurs authentifiés par id, et laisser les requêtes anonymes retomber sur la politique d'adresse.
{ limit: 1000, windowMs: 60_000, keyBy: (ctx) => ctx.user?.id ?? null }
```

Associez une politique d'identité (`null` pour anonyme) à une politique d'adresse pour qu'un flood
anonyme touche quand même une clé — ne laissez jamais une route clefée uniquement par un sélecteur
pouvant retourner `null`.

### Appliquer aux connexions SSE

Le tableau `interceptors` principal ne s'exécute jamais sur un flux SSE (ADR 0017) — mais l'intercepteur
de throttle implémente `ConnectInterceptor`, donc la **même instance** placée dans `interceptors` est
automatiquement exécutée lors de la **tentative de connexion** SSE. Rien de plus à câbler :

```typescript
HttpGatewayModule.configure({
  imports: [
    /* ... */
  ],
  contextFactory: {
    /* ... */
  },
  interceptors: {
    inject: [throttleInterceptorRef()],
    factory: (throttle) => [throttle], // appliqué à la requête ET à la connexion SSE — un moteur, un store
  },
});
```

La tentative de connexion est appliquée avant les guards ; les **événements** du flux ne sont jamais
comptés. Une connexion refusée reçoit une enveloppe `429` avec `Retry-After`, exactement comme une route
bufferisée. Déclarez la politique d'un flux avec `sse("/stream", { throttle: { ... } }, fn)`. Un
intercepteur limité à la requête (qui n'implémente pas `ConnectInterceptor`, ex. un unit-of-work tenant
une transaction) n'est jamais exécuté à la connexion.

### Valider les specs route-inline au boot

Le boot échoue sur une mauvaise politique de **configure** d'office (limit non positive, nom dupliqué,
`'ip'` sur IPC, …). Pour valider aussi les specs **route-inline** au démarrage — pour qu'une coquille
échoue au boot, pas au premier dispatch — placez le **meta validateur** de throttle dans les
`metaValidators` de la gateway, à côté de l'intercepteur dans `interceptors`, sur la **même** gateway :

```typescript
import {
  throttleInterceptorRef,
  throttleMetaValidatorRef,
} from "@spinejs/throttle";

HttpGatewayModule.configure({
  imports: [
    ThrottleModule.configure({
      policies: {
        /* ... */
      },
      ...throttleHttp(),
    }),
  ],
  contextFactory: {
    /* ... */
  },
  interceptors: {
    inject: [throttleInterceptorRef()],
    factory: (throttle) => [throttle], // application à la requête / à la connexion SSE
  },
  metaValidators: {
    inject: [throttleMetaValidatorRef()],
    factory: (validator) => [validator], // validation au boot du `meta.throttle` de chaque route
  },
});
```

`metaValidators` est une primitive du framework ([`MetaValidator`](../gateway/interceptors.md#valider-le-meta-des-routes-au-boot)) :
au démarrage, la gateway croise **ses propres** routes avec **ses propres** validateurs et fait échouer
le boot avec la route nommée sur tout `meta.throttle` invalide (un `keyBy` non câblé, un `skip`/`override`
nommant un défaut inconnu, une valeur d'`override` exotique). Comme le validateur vit sur la gateway qui
_applique_ le throttling, les routes validées sont exactement les routes appliquées — une app
multi-gateway ne valide jamais de façon croisée. Utilisez le nom correspondant pour une instance
nommée : `throttleMetaValidatorRef("public")`.

### Observer les rejets

```typescript
ThrottleModule.configure({
  policies: {
    /* ... */
  },
  onLimitReached: ({ policyName, routeId, keyHash, retryAfterMs }) => {
    metrics.increment("throttle.rejected", { policyName, routeId });
  },
  onError: ({ policyName, phase, error }) => {
    // Un sélecteur de clé qui jette ou une panne du store — télémétrie fail-closed, jamais silencieuse.
    logger.error(`throttle ${phase} failure on ${policyName}`, error);
  },
});
```

`keyHash` est le hash SHA-256 stocké, jamais la clé brute (PII). Optez pour la clé brute avec
`emitRawKey: true` seulement si nécessaire. Les deux hooks sont non porteurs : un observateur qui jette
ne casse jamais l'application.

### Plusieurs gateways

Donnez à chaque gateway sa propre instance isolée avec `name` — la config ne fusionne jamais entre
instances :

```typescript
ThrottleModule.configure({
  name: "public",
  policies: {
    /* ... */
  },
  ...throttleHttp(),
});
ThrottleModule.configure({
  name: "admin",
  policies: {
    /* ... */
  },
  ...throttleHttp(),
});
// Câblez chaque gateway avec throttleInterceptorRef("public") / throttleInterceptorRef("admin").
```

## Référence

### `ThrottleModule.configure(options): DynamicModule`

| Option           | Type                              | Notes                                                                                                       |
| ---------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `policies`       | `Record<string, ThrottlePolicy>`  | Politiques par défaut de gateway, par nom unique. Les noms ne peuvent pas contenir `#`.                     |
| `store`          | `ThrottleStore`                   | Store personnalisé (ex. Redis). Défaut : le store in-memory à log glissant intégré (possédé par le module). |
| `keySources`     | `Record<string, KeySelector>`     | Sources nommées qu'un `keyBy` string résout (`'ip'`/`'sender'` depuis les presets).                         |
| `onLimitReached` | `(e: LimitReachedEvent) => void`  | Émis à chaque rejet : `{ policyName, routeId, keyHash, retryAfterMs }`.                                     |
| `onError`        | `(e: ThrottleErrorEvent) => void` | Émis sur un sélecteur qui jette / une panne du store (télémétrie fail-closed **et** fail-open).             |
| `onOutcome`      | `(ctx) => void`                   | Invoqué une fois par dispatch après l'écriture du slot d'outcome (le traducteur d'en-têtes `./http`).       |
| `emitRawKey`     | `boolean`                         | Passe aussi la clé brute (pré-hash) à `onLimitReached`. Désactivé par défaut (PII).                         |
| `clock`          | `Clock`                           | Source de temps injectable pour le store par défaut (monotone) — tests déterministes.                       |
| `name`           | `string`                          | Nom d'instance pour les apps multi-gateway ; chaque nom est totalement isolé (jamais fusionné).             |

Pour valider les specs route-inline au boot, placez `throttleMetaValidatorRef(name)` dans les
`metaValidators` de la gateway (voir [Valider les specs route-inline au boot](#valider-les-specs-route-inline-au-boot)) —
il est exporté par `configure` à côté de `throttleInterceptorRef(name)`, ce n'est pas une option de `configure`.

### `ThrottlePolicy`

| Champ      | Type                    | Défaut          | Notes                                                                                     |
| ---------- | ----------------------- | --------------- | ----------------------------------------------------------------------------------------- |
| `limit`    | `number`                | —               | Max de hits acceptés par clé par fenêtre. Entier positif, ≤ 10 000 (plafond de sécurité). |
| `windowMs` | `number`                | —               | Longueur de la fenêtre glissante (ms). Positive.                                          |
| `keyBy`    | `string \| KeySelector` | —               | Un nom de source de clé câblée, ou `(ctx, rawInput) => string \| null` (`null` = ignore). |
| `scope`    | `"route" \| "gateway"`  | `"route"`       | `'gateway'` = un bucket par clé sur toutes les routes (configure uniquement).             |
| `failOpen` | `boolean`               | `false`         | Sur une panne store/sélecteur : fail-closed (rejet) par défaut ; `true` ignore.           |
| `maxKeys`  | `number`                | défaut du store | Max de clés suivies dans l'espace LRU isolé de cette politique. Entier positif.           |

### L'option de route `throttle`

Disponible sur les helpers de verbe HTTP, `sse()`, et `handle()` IPC une fois le preset correspondant
(`@spinejs/throttle/http` ou `.../electron-ipc`) importé.

| Champ      | Type                                      | Notes                                                                 |
| ---------- | ----------------------------------------- | --------------------------------------------------------------------- |
| `policies` | `ThrottlePolicy[]`                        | Politiques route-inline, scopées `routeId#index`, non surchargeables. |
| `skip`     | `string[]`                                | Défauts nommés de gateway désactivés pour cette route.                |
| `override` | `Record<string, Partial<ThrottlePolicy>>` | Défauts nommés réajustés pour cette route (appliqués en scope route). |
| — ou —     | `false`                                   | Se désengager de toute politique par défaut pour cette route.         |

### Preset `./http`

- `throttleHttp(options?)` — à étaler dans `configure` : câble la source `'ip'` **et** le traducteur
  outcome→en-têtes (activé par défaut). Options : `trustProxy`, `ipv6PrefixBits`, `headers` (`false`
  désactive toute émission d'en-têtes), `keySources` supplémentaires.
- `ipKeySource(options?)` — la source `'ip'` seule (socket direct par défaut ; `trustProxy` pour les
  reverse proxies ; normalisation IPv4-mapped/NAT64 avant le masque IPv6 /56).
- `rateLimitHeaders(options?)` — le traducteur outcome→en-têtes autonome (pour un `onOutcome` custom).
- `THROTTLE_STATUS_MAPPING` — le `{ TOO_MANY_REQUESTS: 429 }` qu'un `statusMapper` http-gateway
  personnalisé doit porter. Étalez-le dans votre propre mapper.

### Preset `./electron-ipc`

- `senderKeySource()` — la source de clé `'sender'` (clef par `event.sender.id`).

### `./testing`

Un kit de tests de contrat réutilisable qui fige la sémantique de `consume` (atomicité, `resetMs`
relatif, croissance limitée aux hits acceptés, consommation inconditionnelle). Exécutez-le contre
n'importe quel store personnalisé pour le valider.

Le store in-memory garde les limites **par process** — plusieurs réplicas appliquent chacun leur propre
fenêtre. Pour une limite partagée entre instances, implémentez le port `ThrottleStore` sur un backend
partagé (ex. Redis) et validez-le avec le kit `./testing`.
