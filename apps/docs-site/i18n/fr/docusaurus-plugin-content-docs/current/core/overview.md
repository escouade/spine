---
sidebar_position: 1
---

# Aperçu

`@spinejs/core` est la couche fondatrice de l'écosystème. Elle fournit trois primitives à partir desquelles toute application SpineJS est construite : le **système de modules** (unité structurelle de code), le **conteneur DI** (câblage des dépendances) et l'**orchestrateur App** (gestion du cycle de vie et des signaux du process).

## La classe `App`

`App` est le point d'entrée. Elle accepte une liste de valeurs `ModuleEntry`, câble le conteneur DI et pilote le cycle de vie `init → start → stop`.

```typescript
import { App } from "@spinejs/core";
import { ConfigModule } from "@spinejs/config";
import { AppModule } from "./app.module";

const app = new App([ConfigModule.configure({ configs: [] }), AppModule], {
  // Optional: swap the built-in console logger for a Winston instance.
  // logger: new WinstonLogger({ level: 'debug', dir: '/var/log/myapp' }),

  // Optional: control the minimum log level of the built-in console logger.
  loggerOptions: { level: process.env.LOG_LEVEL ?? "info" },
});

await app.init(); // Build the module graph, run onInit() on every module.
await app.start(); // Run onStart() on every module that implements OnStart.
```

### `AppOptions`

| Option              | Type            | Défaut      | Description                                                                                         |
| ------------------- | --------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| `logger`            | `Logger`        | `AppLogger` | Instance de logger personnalisée (remplace celle intégrée).                                         |
| `loggerOptions`     | `LoggerOptions` | `{}`        | Options transmises au `AppLogger` intégré.                                                          |
| `handleProcessExit` | `boolean`       | `true`      | Quand `true`, écoute `SIGINT`/`SIGTERM` et appelle `app.exit()`.                                    |
| `shutdownTimeout`   | `number`        | `5000`      | Durée max (ms) de la séquence d'arrêt avant que `exit()` force la sortie ; `0` attend indéfiniment. |

### Méthodes

| Méthode       | Description                                                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `init()`      | Charge tous les modules dans l'ordre des dépendances, en appelant `onInit()` sur chacun. Lève une erreur (et s'auto-arrête) en cas d'échec. |
| `start()`     | Appelle `onStart()` sur chaque module qui implémente `OnStart`. Lève une erreur (et s'auto-arrête) en cas d'échec.                          |
| `stop()`      | Appelle `onStop()` dans l'ordre d'init inverse. Idempotent — sûr à appeler plusieurs fois.                                                  |
| `exit(code?)` | Arrête l'application, vide le logger, puis appelle `process.exit(code)`. Sûr en ré-entrance.                                                |

## Tokens globaux

Deux valeurs `InjectionToken` sont pré-enregistrées dans le conteneur global de chaque application :

```typescript
import { appToken, loggerToken } from "@spinejs/core";

@Module({
  inject: [appToken, loggerToken],
})
export class MyModule {
  constructor(private readonly app: App, private readonly logger: Logger) {}
}
```

- **`appToken`** — résout l'instance `App` elle-même. Utile quand un module doit déclencher un arrêt propre (par ex. `ElectronModule` intercepte `before-quit`).
- **`loggerToken`** — résout le `Logger` actif (soit `AppLogger`, soit un logger personnalisé passé dans `AppOptions`).

## Gestion des signaux du process

Par défaut, `App` enregistre des écouteurs pour `SIGINT` et `SIGTERM` qui appellent `app.exit()`. Les deux signaux déclenchent un arrêt propre : tous les hooks `onStop()` s'exécutent, le logger vide ses tampons, puis le process se termine avec le code `0`.

Les exceptions non rattrapées et les rejets de promesse non gérés sont aussi interceptés : l'erreur est journalisée, puis `app.exit(1)` est appelé.

Lorsque l'application s'arrête (avec succès ou après une erreur), ces écouteurs sont retirés automatiquement pour éviter tout redéclenchement intempestif.
