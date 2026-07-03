---
sidebar_position: 2
---

# Winston Logger

`@spinejs/winston-logger` fournit un logger de qualité production pour les applications SpineJS. Il implémente l'interface `Logger` de `@spinejs/core`, ce qui en fait un remplacement clé en main pour l'`AppLogger` intégré. La dépendance Winston et ses dépendances transitives (winston, logform, triple-beam) vivent dans ce package — le cœur de SpineJS reste sans dépendance.

## Installation

Passez une instance `WinstonLogger` à `AppOptions.logger` lors de la construction de votre `App` :

```typescript
import { App } from "@spinejs/core";
import { WinstonLogger } from "@spinejs/winston-logger";

const app = new App([AppModule], {
  logger: new WinstonLogger({
    level: "info",
    stdout: true,
    dir: "/var/log/myapp",
    files: [{ filename: "app.log" }, { filename: "error.log", level: "error" }],
  }),
});
```

C'est le seul changement nécessaire. L'instance `WinstonLogger` est automatiquement enregistrée sous `loggerToken` et injectée dans tout module qui la demande.

## `WinstonLoggerOptions`

| Option       | Type                   | Défaut                    | Description                                                                        |
| ------------ | ---------------------- | ------------------------- | ---------------------------------------------------------------------------------- |
| `level`      | `LogLevel \| string`   | Défaut Winston (`'info'`) | Niveau de log minimum émis.                                                        |
| `stdout`     | `boolean`              | `true`                    | Quand `true`, ajoute un transport Console avec sortie colorée.                     |
| `dir`        | `string`               | —                         | Répertoire de base pour les transports fichier. Requis quand `files` est non vide. |
| `json`       | `boolean`              | `false`                   | Émet les logs fichier en JSON (actuellement désactivé — réservé à un usage futur). |
| `files`      | `LogFileConfig[]`      | `[]`                      | Tableau de configurations de transport fichier (voir ci-dessous).                  |
| `transports` | `unknown[]`            | `[]`                      | Transports Winston bruts à ajouter (pour cas d'usage avancés).                     |
| `console`    | `ConsoleFormatOptions` | —                         | Réglages du formateur console (couleurs, horodatages, pid).                        |

## Transports fichier avec `LogFileConfig`

`LogFileConfig` reflète le `FileTransportOptions` de Winston. Au minimum vous avez besoin de `filename` :

```typescript
import { WinstonLogger } from "@spinejs/winston-logger";

const logger = new WinstonLogger({
  dir: "/var/log/myapp",
  files: [
    // All log levels:
    { filename: "combined.log" },
    // Errors only:
    { filename: "error.log", level: "error" },
    // Rotating files (requires winston-daily-rotate-file transport in `transports`):
    { filename: "app-%DATE%.log" },
  ],
});
```

L'option `dir` est répandue automatiquement dans chaque `LogFileConfig.dirname`. Un `format` personnalisé peut être défini par fichier — en son absence, un format texte par défaut `[timestamp] [level] message` est utilisé.

## Héritage du niveau de log

Chaque transport fichier respecte son propre `level`. Le `level` global du logger agit comme plancher — un transport avec `level: 'error'` ne reçoit toujours que les erreurs même si le `level` du logger est `'debug'`.

```typescript
const logger = new WinstonLogger({
  level: "debug", // console receives everything from debug up
  files: [
    { filename: "debug.log", level: "debug" }, // all levels
    { filename: "error.log", level: "error" }, // only error and fatal
  ],
});
```

## Avancé : transports Winston bruts

Passez n'importe quel transport compatible Winston via l'option `transports` :

```typescript
import * as winston from "winston";
import { WinstonLogger } from "@spinejs/winston-logger";
import DailyRotateFile from "winston-daily-rotate-file";

const logger = new WinstonLogger({
  level: "info",
  transports: [
    new DailyRotateFile({
      dirname: "/var/log/myapp",
      filename: "app-%DATE%.log",
      datePattern: "YYYY-MM-DD",
      maxFiles: "14d",
    }),
  ],
});
```

## `exit()` — vidage à l'arrêt

`WinstonLogger` implémente `Logger.exit()` en appelant `winston.end()` et en attendant jusqu'à 200 ms que les écritures en tampon se vident. `App.exit()` l'appelle automatiquement avant `process.exit()`.

Si vous utilisez des transports fichier, assurez-vous que `logger.exit()` ait le temps de se terminer. L'`App` s'en charge pour vous lorsque vous passez le logger comme `AppOptions.logger`.

## Gestion des erreurs

Si un transport fichier rencontre une erreur de permission (`EACCES`), le logger lève immédiatement une erreur pendant la construction. Les autres erreurs de transport sont rattrapées et re-journalisées.

```typescript
// This throws if /root/logs is not writable:
const logger = new WinstonLogger({
  dir: "/root/logs",
  files: [{ filename: "app.log" }],
});
```

Validez les permissions d'écriture avant la construction en production (par ex. `accessSync` ou un health check de démarrage).

## Utiliser le logger dans les modules

Le logger est accessible via `loggerToken` dans tout module une fois l'application démarrée. Le type est l'interface `Logger` — votre module reste découplé de la classe concrète `WinstonLogger` :

```typescript
import { Module, Logger, loggerToken } from "@spinejs/core";

@Module({ inject: [loggerToken] })
export class MyModule {
  constructor(private readonly logger: Logger) {}

  async onInit(): Promise<void> {
    this.logger.info("MyModule is ready", MyModule.name);
  }
}
```
