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
