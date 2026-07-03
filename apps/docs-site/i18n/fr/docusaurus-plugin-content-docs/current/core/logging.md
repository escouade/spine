---
sidebar_position: 5
---

# Logging

SpineJS livre un logger console sans dépendance (`AppLogger`) qui couvre les cas d'usage courants en développement et en production. Pour une sortie plus riche — transports fichier, JSON, rotation des logs — le package optionnel `@spinejs/winston-logger` fournit un remplacement clé en main.

## Logger dans votre code

Le logger actif est enregistré sous `loggerToken`. Injectez-le dans n'importe quel module ou service et appelez une méthode de niveau :

```typescript
import { Module, Logger, loggerToken } from "@spinejs/core";

@Module({ inject: [loggerToken] })
export class AuthModule {
  constructor(private readonly logger: Logger) {}

  async onInit(): Promise<void> {
    this.logger.info("AuthModule initialized", AuthModule.name);
  }
}
```

Typez le champ en `Logger` (l'interface), **pas** `AppLogger` — le même module fonctionne alors sans changement, que l'app utilise le logger intégré ou Winston. C'est tout ce dont vous avez besoin au quotidien ; les sections ci-dessous couvrent l'interface, les options du logger intégré, le remplacement de l'implémentation et l'échelle des niveaux.

## L'interface `Logger`

Tous les loggers de l'écosystème implémentent la même interface :

```typescript
interface Logger {
  verbose(message: unknown, ...params: unknown[]): void;
  debug(message: unknown, ...params: unknown[]): void;
  info(message: unknown, ...params: unknown[]): void;
  warn(message: unknown, ...params: unknown[]): void;
  error(message: unknown, ...params: unknown[]): void;
  fatal(message: unknown, ...params: unknown[]): void;
  exit(): void | Promise<void>;
}
```

La méthode `exit()` est appelée par `app.exit()` pour laisser le logger vider ses écritures en tampon avant que le process ne se termine.

## `AppLogger` intégré

`AppLogger` écrit une sortie colorée et horodatée vers `process.stdout`/`process.stderr`. Il n'a aucune dépendance externe.

```typescript
import { AppLogger } from "@spinejs/core";

const logger = new AppLogger({
  level: "debug", // 'verbose' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  appName: "MyApp", // Prefix shown in brackets: [MyApp]
  stdout: true, // Write info/debug/verbose to stdout (default true)
});

logger.info("Application started", "Bootstrap");
// [timestamp] [info] [MyApp] [Bootstrap] Application started

logger.error(new Error("Something went wrong"), "AuthService");
// [timestamp] [error] [MyApp] [AuthService] Something went wrong
//   Error: Something went wrong
//     at ...
```

### `LoggerOptions`

| Option    | Type                   | Défaut   | Description                                               |
| --------- | ---------------------- | -------- | --------------------------------------------------------- |
| `level`   | `LogLevel \| string`   | `'info'` | Niveau minimum émis.                                      |
| `stdout`  | `boolean`              | `true`   | Émet `info` et en dessous vers `stdout` (sinon `stderr`). |
| `appName` | `string`               | `'App'`  | Préfixe affiché sur chaque ligne de log.                  |
| `console` | `ConsoleFormatOptions` | `{}`     | Réglages fins du rendu console (couleurs, pid, etc.).     |

## Logger personnalisé

Passez n'importe quelle instance compatible `Logger` à `AppOptions.logger` pour remplacer celui intégré :

```typescript
import { App } from "@spinejs/core";
import { WinstonLogger } from "@spinejs/winston-logger";

const app = new App([AppModule], {
  logger: new WinstonLogger({
    level: "debug",
    dir: "/var/log/myapp",
    files: [{ filename: "app.log" }, { filename: "error.log", level: "error" }],
  }),
});
```

Voir [Winston Logger](../extensions/winston-logger) pour la référence complète de `WinstonLoggerOptions`.

## Niveaux de log

Niveaux par sévérité croissante :

| Niveau    | Méthode            | Usage                                                   |
| --------- | ------------------ | ------------------------------------------------------- |
| `verbose` | `logger.verbose()` | Détails de traçage (résolution du conteneur, DI, etc.). |
| `debug`   | `logger.debug()`   | Diagnostics en développement.                           |
| `info`    | `logger.info()`    | Messages opérationnels normaux.                         |
| `warn`    | `logger.warn()`    | Anomalies récupérables.                                 |
| `error`   | `logger.error()`   | Erreurs qui ne font pas planter le process.             |
| `fatal`   | `logger.fatal()`   | Erreurs qui déclenchent la sortie du process.           |

Régler `level: 'warn'` n'émet que `warn`, `error` et `fatal` — les messages de niveau inférieur sont silencieusement ignorés.
