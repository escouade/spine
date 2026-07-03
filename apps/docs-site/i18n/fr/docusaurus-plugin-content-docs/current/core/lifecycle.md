---
sidebar_position: 4
---

# Cycle de vie

SpineJS orchestre l'initialisation et le démontage des modules via trois interfaces optionnelles : `OnInit`, `OnStart` et `OnStop`. Les implémenter est entièrement facultatif — un module qui n'a pas besoin de hooks de cycle de vie ne les implémente simplement pas.

## Interfaces

```typescript
interface OnInit {
  onInit(): void | Promise<void>;
}
interface OnStart {
  onStart(): void | Promise<void>;
}
interface OnStop {
  onStop(): void | Promise<void>;
}
```

Les trois méthodes peuvent être `async`. SpineJS attend (`await`) chacune avant de passer au module suivant.

## Phase 1 — `init()` et `onInit()`

`app.init()` charge le graphe de modules. Le loader effectue un tri topologique de sorte que les dépendances d'un module soient toujours initialisées avant le module lui-même.

Au sein de chaque module, la séquence est :

1. Résoudre tous les providers via DI.
2. Instancier la classe du module (injecter les dépendances de constructeur).
3. Appeler `onInit()` si le module implémente `OnInit`.

```typescript
@Module({
  inject: [DatabaseService],
  imports: [DatabaseModule],
})
export class UserModule implements OnInit {
  constructor(private readonly db: DatabaseService) {}

  async onInit(): Promise<void> {
    // DatabaseModule.onInit() has already run at this point.
    await this.db.createSchema();
  }
}
```

### Démarrage atomique

Si le `onInit()` d'un module lève une erreur, `app.init()` appelle `app.stop()` avant de relancer l'erreur. Les modules ayant terminé `onInit()` avec succès reçoivent leur appel `onStop()` ; le module en échec ne le reçoit pas (il n'est jamais entré dans l'ensemble des initialisés). Cela garantit qu'aucun état partiellement démarré ne reste actif.

```typescript
try {
  await app.init();
  await app.start();
} catch (err) {
  // app.stop() has already been called — safe to exit.
  await app.exit(1);
}
```

## Phase 2 — `start()` et `onStart()`

`app.start()` s'exécute après que `app.init()` est terminé. Il appelle `onStart()` sur chaque module qui implémente `OnStart`, là encore dans l'ordre d'init (dépendances avant dépendants).

`onStart()` est destiné au travail qui doit avoir lieu une fois le graphe de modules entièrement initialisé — par exemple démarrer un serveur auquel d'autres modules pourraient se connecter, ou exécuter des migrations qui dépendent d'une base de données entièrement configurée.

```typescript
@Module({ inject: [HttpServer] })
export class ServerModule implements OnStart {
  constructor(private readonly server: HttpServer) {}

  async onStart(): Promise<void> {
    await this.server.listen(3000);
  }
}
```

Comme pour `init()`, si un `onStart()` lève une erreur, `app.stop()` est appelé avant de relancer l'erreur.

:::note `start()` est terminal après `stop()`
Appeler `app.start()` après `app.stop()` lève immédiatement une erreur. L'appeler une seconde fois sur une application en cours d'exécution est sans effet.
:::

## Phase 3 — `stop()` et `onStop()`

`app.stop()` est appelé sur `SIGINT`, `SIGTERM`, une exception non rattrapée, ou manuellement via `app.stop()`. Il appelle `onStop()` dans l'**ordre d'init inverse** — les dépendants s'arrêtent avant leurs dépendances.

`onStop()` est apparié à `onInit()`, pas à `onStart()`. Un module qui a terminé `onInit()` est garanti de recevoir `onStop()` à l'arrêt, que `onStart()` ait été appelé ou terminé avec succès ou non.

```typescript
@Module({ inject: [DatabaseService] })
export class DatabaseModule implements OnInit, OnStop {
  constructor(private readonly db: DatabaseService) {}

  async onInit(): Promise<void> {
    await this.db.connect();
  }

  async onStop(): Promise<void> {
    // Runs after all modules that imported DatabaseModule have stopped.
    await this.db.disconnect();
  }
}
```

### Idempotence

`app.stop()` est idempotent : l'appeler plusieurs fois est sûr. Le second appel est sans effet. C'est important car `app.exit()` appelle `stop()`, et le gestionnaire de signaux du process appelle aussi `exit()` — sans idempotence, une course entre un SIGTERM et un `app.exit()` explicite double-appellerait les hooks `onStop()`.

## `exit()` — arrêt propre du process

`app.exit(code?)` effectue un arrêt complet :

1. Appelle `app.stop()` (idempotent — sûr si déjà arrêté).
2. Appelle `logger.exit()` pour vider les entrées de log en tampon.
3. Appelle `process.exit(code)`.

Il est sûr en ré-entrance : un appel en double (par ex. depuis un second signal) est ignoré une fois le premier démarré.

### Timeout d'arrêt (force exit)

Comme SpineJS intercepte `SIGINT`/`SIGTERM` et possède l'appel à `process.exit()`, il garantit aussi que le process se termine réellement. Un `onStop()` pendu (connexion non fermée, flush bloqué) ne doit pas maintenir le process en vie indéfiniment — sinon il défait la propre fenêtre de kill de l'orchestrateur.

`exit()` arme un timer de kill dur sur toute la séquence d'arrêt : si `stop()` plus le flush du logger ne terminent pas dans `shutdownTimeout` (défaut `5000` ms), le process est forcé à sortir. Le chemin propre annule le timer avant son propre `process.exit()`.

```typescript
const app = new App([AppModule], {
  shutdownTimeout: 3000, // force exit après 3s ; 0 désactive (attente infinie)
});
```

Gardez `shutdownTimeout` en dessous de la fenêtre de grâce de votre orchestrateur (par ex. les 10s par défaut de Docker avant `SIGKILL`) pour que le force-exit du framework tire en premier.

```typescript
// Graceful shutdown from application logic:
const app = new App([AppModule]);
await app.init();
await app.start();

// Later, e.g. from a management API:
await app.exit(0);
```

## Diagramme du flux de cycle de vie

```
new App(modules)
  └─ constructor: global container initialized, process handlers attached

app.init()
  └─ topological sort of module graph
  └─ for each module (deps before dependents):
       resolve providers → instantiate module → onInit() [await]
  └─ on any error: stop() → re-throw

app.start()
  └─ for each module (same order as init):
       onStart() [await]
  └─ on any error: stop() → re-throw

app.stop()  [idempotent]
  └─ for each module (reverse init order):
       onStop() [await]
  └─ detach process listeners

app.exit(code)  [re-entrant-safe]
  └─ arm hard-kill timer (shutdownTimeout) ── on timeout ─→ process.exit(code)
  └─ stop()
  └─ logger.exit()
  └─ clear hard-kill timer
  └─ process.exit(code)
```
