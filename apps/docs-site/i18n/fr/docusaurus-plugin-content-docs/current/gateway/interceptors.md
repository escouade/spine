---
sidebar_position: 4
---

# Intercepteurs

Les intercepteurs enveloppent le pipeline `dispatch()` et sont l'endroit canonique pour les préoccupations transversales : logging, métriques, tracing, audit et transformation de réponse. Vous écrivez un objet avec une méthode `intercept()` qui appelle `next()`, puis vous l'enregistrez via le `configure({ interceptors })` du module de transport. Utilisez-en un dès qu'une logique doit s'exécuter autour de **chaque** route plutôt qu'à l'intérieur d'une seule.

## Écrire un intercepteur

Un intercepteur est tout objet qui implémente l'interface `GatewayInterceptor`. Il reçoit la cible de dispatch, le contexte, l'input brut et un `next()` qui exécute le reste de la chaîne — faites votre travail avant et/ou après l'appel :

```typescript
import type {
  Envelope,
  GatewayContext,
  LoadedRoute,
} from "@spinejs/gateway-core";
import { GatewayInterceptor } from "@spinejs/gateway-core";

// Un intercepteur portable qui ne touche que `ctx` peut implémenter `GatewayInterceptor` avec la
// cible par défaut. Un intercepteur qui lit l'`address`/`meta` de la route restreint la cible à
// `LoadedRoute` :
class LoggingInterceptor
  implements GatewayInterceptor<GatewayContext, string, LoadedRoute>
{
  async intercept(
    route: LoadedRoute,
    ctx: GatewayContext,
    rawInput: unknown,
    next: () => Promise<Envelope<unknown>>
  ): Promise<Envelope<unknown>> {
    console.debug("→", route.address, rawInput);
    const envelope = await next();
    console.debug(
      "←",
      route.address,
      envelope.ok ? "ok" : `error:${envelope.code}`
    );
    return envelope;
  }
}
```

Le premier argument de l'intercepteur est la **cible** de dispatch. Elle vaut par défaut le `DispatchTarget` indépendant du transport (guards + input + invoke) ; restreignez-la à `LoadedRoute<Ctx, Addr>` quand vous avez besoin de l'`address` ou du `meta` de la route, comme ci-dessus.

`next()` délègue à l'intercepteur suivant de la chaîne, ou — si c'est le dernier — au pipeline cœur (guards → validate → invoke). Retournez toujours le résultat de `next()` (ou une enveloppe de remplacement) pour que la chaîne se termine.

## Intercepteurs transport-agnostiques

Un intercepteur qui ne touche que `ctx`/`next` — jamais la route — est **transport-agnostique** : son type est le `GatewayInterceptor<GatewayContext, …>` de base (ex. `ClsInterceptor`, `MikroOrmInterceptor`). Vous l'ajoutez au tableau `interceptors` de n'importe quel transport **tel quel, sans cast**. Chaque transport restreint son slot à son propre contexte + route, mais le type d'élément du slot est un `ChainInterceptor` — une union qui admet soit un intercepteur spécifique au transport, **soit** un intercepteur de base transport-agnostique :

```typescript
import type { ChainInterceptor } from "@spinejs/gateway-core";
// exporté pour référence ; vous le nommez rarement — c'est le type que les slots des transports utilisent déjà.
```

C'est pourquoi `configure({ interceptors: [new ClsInterceptor(cls), ormInterceptor] })` type-check sans `as`, alors même que `ormInterceptor` est typé sur le `GatewayContext` de base et que le slot est restreint à la route du transport.

## Appliquer à la connexion (SSE)

Un flux SSE HTTP contourne le pipeline `interceptors` bufferisé (un flux est plusieurs valeurs, pas une seule `Envelope` — voir [ADR 0017](https://github.com/escouade/spine/blob/main/docs/adr/0017-sse-fan-out-in-http-gateway.md)). Un intercepteur qui doit aussi agir sur la **tentative de connexion** — ex. limiter le débit d'un connect — s'y inscrit en implémentant `ConnectInterceptor` en plus de `GatewayInterceptor` :

```typescript
import type {
  GatewayInterceptor,
  ConnectInterceptor,
} from "@spinejs/gateway-core";

class ThrottleInterceptor implements GatewayInterceptor, ConnectInterceptor {
  intercept(target, ctx, rawInput, next) {
    return this.gate(target, ctx, rawInput, next);
  }
  interceptConnect(target, ctx, rawInput, next) {
    return this.gate(target, ctx, rawInput, next); // même logique, exécutée à la connexion
  }
  private gate(target, ctx, rawInput, next) {
    /* refuser → retourner une enveloppe d'échec ; ou `return next()` pour autoriser la connexion */
  }
}
```

La gateway HTTP dérive sa chaîne de connexion depuis la **même** liste `interceptors`, filtrée sur ceux qui implémentent `interceptConnect` — vous câblez donc l'intercepteur **une seule fois**. Un intercepteur qui n'implémente **pas** `ConnectInterceptor` (un `MikroOrmInterceptor` request-scoped, dont la transaction ne doit pas couvrir un flux long) est exclu de la chaîne de connexion **par défaut** — le filtre ne retient que les intercepteurs exposant `interceptConnect`. À la connexion, `next()` résout un accept synthétique — il n'y a pas de handler en aval — donc court-circuitez pour refuser, ou appelez `next()` pour autoriser.

Un intercepteur qui ne doit agir **qu'**à la connexion (rien sur les requêtes bufferisées) vit quand même dans la liste `interceptors` : donnez-lui donc une méthode de requête pass-through — `intercept(t, c, i, next) { return next(); }`. L'application à la connexion est un sous-ensemble d'`interceptors`, pas une liste indépendante.

## Valider le meta des routes au boot

Les intercepteurs s'exécutent à la **requête**. Une primitive séparée et complémentaire — `MetaValidator` — s'exécute au **boot** : elle valide la tranche namespacée du `meta` de chaque route (ex. `meta.throttle`) pour qu'une coquille échoue au démarrage, pas au premier dispatch. C'est un concept **différent** d'un intercepteur (type différent, slot différent, cycle de vie différent) — ne confondez pas les deux.

Câblez les validateurs via le même schéma d'adaptateur `configure()`, dans le slot `metaValidators`. Une battery expose un token de validateur que vous placez à côté de son intercepteur, sur la **même** gateway :

```typescript
HttpGatewayModule.configure({
  imports: [ThrottleModule.configure({ policies: {} })],
  contextFactory: {
    /* ... */
  },
  interceptors: { inject: [throttleInterceptorRef()], factory: (i) => [i] }, // à la requête
  metaValidators: { inject: [throttleMetaValidatorRef()], factory: (v) => [v] }, // au boot
});
```

Au démarrage, la gateway croise **ses propres** routes avec **ses propres** validateurs — pour chaque route dont le `meta` porte le `namespace` d'un validateur, elle appelle `validate(routeId, meta[namespace])` ; un throw fait échouer le boot avec la route nommée, avant que le transport n'ouvre (HTTP : avant `listen()`). Aucun validateur câblé → aucune traversée (rétrocompatible). Comme la gateway possède les deux moitiés, les routes validées sont exactement celles que cette gateway applique — un validateur ne peut jamais être câblé à la mauvaise gateway.

Un validateur implémente une seule méthode, exécutée au boot :

```typescript
import type { MetaValidator } from "@spinejs/gateway-core";

class ThrottleMetaValidator implements MetaValidator {
  readonly namespace = "throttle"; // seules les routes portant `meta.throttle` sont validées
  validate(routeId: string, meta: unknown): void {
    /* lever une erreur de config typée (route nommée) sur une spec invalide */
  }
}
```

## Ordre d'exécution

Les intercepteurs sont chaînés dans l'ordre d'enregistrement. Le premier intercepteur du tableau est l'enveloppe la plus externe — il s'exécute en premier à l'aller et en dernier au retour :

```
[Interceptor A] → [Interceptor B] → guards → validate → invoke → [B returns] → [A returns]
```

## Câblage via `ElectronIpcGatewayModule.configure()`

Passez les intercepteurs à travers l'appel `configure()`. L'option `interceptors` suit le même pattern d'adaptateur que les autres ports — elle accepte une simple `value` ou une `factory` DI avec une liste `inject` :

```typescript
import { loggerToken, Logger } from "@spinejs/core";
import {
  ElectronIpcGatewayModule,
  IpcLoggingInterceptor,
} from "@spinejs/electron-ipc-gateway";

ElectronIpcGatewayModule.configure({
  imports: [SessionModule],
  contextFactory: {
    /* … */
  },
  errorMapper: {
    /* … */
  },
  interceptors: {
    inject: [loggerToken],
    factory: (logger: Logger) => [new IpcLoggingInterceptor(logger)],
  },
});
```

Quand `interceptors` est omis, la gateway s'exécute sans aucun intercepteur.

## `IpcLoggingInterceptor`

`@spinejs/electron-ipc-gateway` livre un intercepteur de logging prêt à l'emploi. Il journalise chaque dispatch IPC au niveau `debug` en utilisant le `Logger` de SpineJS :

```
→ conversations:messages {"conversationId":"abc123"}
← conversations:messages ok
→ chat:send {"content":"hello"}
← chat:send error:SERVER
```

Câblez-le comme montré ci-dessus. L'intercepteur utilise le `loggerToken` de SpineJS, il récupère donc la même instance de logger que le reste de l'application.

### Masquer les entrées sensibles

Par défaut, l'entrée brute est journalisée telle quelle au niveau `debug` — des mots de passe ou tokens envoyés par IPC finiraient dans les logs. Passez un `IpcLogRedactor` comme second argument du constructeur pour masquer ce qui est journalisé ; il reçoit le canal, le masquage peut donc être par canal. L'entrée réelle transmise au handler n'est jamais modifiée :

```typescript
import {
  IpcLoggingInterceptor,
  IpcLogRedactor,
} from "@spinejs/electron-ipc-gateway";

const redact: IpcLogRedactor = (channel, input) =>
  channel.startsWith("auth:") ? "[redacted]" : input;

interceptors: {
  inject: [loggerToken],
  factory: (logger: Logger) => [new IpcLoggingInterceptor(logger, redact)],
},
```

```
→ auth:login "[redacted]"
← auth:login ok
→ chat:send {"content":"hello"}
← chat:send ok
```

Le framework reste neutre : c'est l'application qui décide quels canaux ou champs masquer.

## Écrire des intercepteurs personnalisés

Les intercepteurs peuvent injecter n'importe quel service et effectuer un travail asynchrone arbitraire avant et après le pipeline. Ils peuvent aussi court-circuiter en retournant une enveloppe sans appeler `next()` :

```typescript
import {
  GatewayInterceptor,
  Envelope,
  GatewayContext,
  LoadedRoute,
} from "@spinejs/gateway-core";
import { MetricsService } from "../metrics";

export class MetricsInterceptor
  implements GatewayInterceptor<GatewayContext, string, LoadedRoute>
{
  constructor(private readonly metrics: MetricsService) {}

  async intercept(
    route: LoadedRoute,
    ctx: GatewayContext,
    rawInput: unknown,
    next: () => Promise<Envelope<unknown>>
  ): Promise<Envelope<unknown>> {
    const start = Date.now();
    const envelope = await next();
    this.metrics.record(route.address, Date.now() - start, envelope.ok);
    return envelope;
  }
}
```

Les intercepteurs ne sont pas résolus automatiquement par DI — vous les instanciez dans la `factory` de l'adaptateur `interceptors` et injectez leurs dépendances via `inject`.
