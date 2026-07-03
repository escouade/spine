---
sidebar_position: 5
---

# Modules de fonctionnalité

Les modules de fonctionnalité sont la colle entre vos contrôleurs et un transport de gateway. Ils encapsulent le câblage : instancier les contrôleurs via DI, résoudre les instances de guard, construire la guard map, et enregistrer les routes résultantes sur la gateway — le tout dans un `onInit()` synthétisé.

`@spinejs/gateway-core` fournit deux fonctions de confort qui produisent ce câblage à partir d'un binding spécifique au transport :

| Fonction                                   | Style                                                | Quand l'utiliser                                                |
| ------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------- |
| `gatewayFeatureFactory(token, transport)`  | Factory — retourne un `DynamicModule`                | Enregistrement inline d'une fonctionnalité, sans classe nommée. |
| `gatewayModuleDecorator(token, transport)` | Décorateur — remplace une classe par une sous-classe | Style NestJS, conserve une `export class` nommée.               |

Les deux sont liées une fois par transport pour produire les helpers spécifiques à l'application (`ipcFeature` / `@IpcModule` dans l'application de référence).

## Créer des helpers spécifiques au transport

Liez les fonctions génériques à la classe de gateway et au module de votre transport :

```typescript
// electron-ipc-module.ts
import {
  gatewayFeatureFactory,
  gatewayModuleDecorator,
} from "@spinejs/gateway-core";
import { ElectronIpcGateway } from "@spinejs/electron-ipc-gateway";
import { ElectronIpcGatewayModule } from "./electron-ipc-gateway.module";

/**
 * Factory form — no named module class:
 *   imports: [ ipcFeature({ controllers: [PingController] }) ]
 */
export const ipcFeature = gatewayFeatureFactory(
  ElectronIpcGateway,
  ElectronIpcGatewayModule
);

/**
 * Decorator form — keeps a named module class:
 *   @IpcModule({ controllers: [PingController] })
 *   export class PingModule {}
 */
export const IpcModule = gatewayModuleDecorator(
  ElectronIpcGateway,
  ElectronIpcGatewayModule
);
```

## `ipcFeature` — forme factory

La forme factory est la primitive. Elle produit un `DynamicModule` qui peut être passé directement à `imports` :

```typescript
import { Module } from "@spinejs/core";
import { ipcFeature } from "./electron-ipc-module";
import { HealthController } from "./health.controller";
import { UserController } from "./user.controller";

@Module({
  imports: [
    ipcFeature({ controllers: [HealthController] }),
    ipcFeature({
      controllers: [UserController],
      imports: [UserModule], // imports supplémentaires requis par UserController
    }),
  ],
})
export class AppModule {}
```

## `@IpcModule` — forme décorateur

La forme décorateur remplace la classe décorée par une sous-classe dotée du `onInit` synthétisé. Vous conservez une classe de module nommée et exportable :

```typescript
import { IpcModule } from "./electron-ipc-module";
import { ProjectsController } from "./projects.controller";
import { ProjectsModule } from "./projects.module";
import { SessionGuard } from "../session.guard";

@IpcModule({
  controllers: [ProjectsController],
  imports: [ProjectsModule],
})
export class ProjectsIpcModule {}
```

## `FeatureModuleConfig`

Les deux formes acceptent le même objet de config :

```typescript
interface FeatureModuleConfig extends ModuleMetadata {
  controllers: ProviderConstructor[];
}
```

| Champ         | Type                    | Description                                                                                                                                      |
| ------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `controllers` | `ProviderConstructor[]` | Classes de contrôleur à enregistrer. Requis.                                                                                                     |
| `imports`     | `ModuleEntry[]`         | Modules supplémentaires à importer dans ce module de fonctionnalité.                                                                             |
| `providers`   | `ProviderEntry[]`       | Providers supplémentaires au-delà des contrôleurs.                                                                                               |
| `exports`     | `Token[]`               | Tokens à exporter depuis ce module de fonctionnalité.                                                                                            |
| `inject`      | `Token[]`               | Dépendances de constructeur supplémentaires pour la classe du module (forme décorateur uniquement, pour le constructeur propre à l'utilisateur). |

## Fonctionnement du `onInit()` synthétisé

Quand le module de fonctionnalité s'initialise, le framework :

1. Construit l'ordre d'injection DI `[gatewayToken, ...controllerClasses, ...userInject]` et reçoit les instances résolues.
2. Lit son **propre container** (estampillé par le module loader du cœur sur un slot caché juste avant `onInit`).
3. Parcourt chaque instance de contrôleur pour collecter les classes de guards référencées — `@UseGuards` de classe plus l'option `guards` par route sur les markers de champ — en résolvant chacune depuis ce container (enregistrement à la volée d'une classe inconnue), pour construire le `guardMap: Map<GuardConstructor, Guard>`.
4. Pour chaque contrôleur, appelle `getRoutes(controllerInstance, guardMap)` pour produire `LoadedRoute[]`.
5. Appelle `gateway.register(routes)` avec toutes les routes.
6. Si la classe de l'utilisateur (forme décorateur) a son propre `onInit()`, l'appelle ensuite.

## Exemple complet de câblage

Voici un module de fonctionnalité IPC complet avec guards, contexte authentifié et plusieurs contrôleurs :

```typescript
// projects.ipc.module.ts
import { IpcModule } from "../infrastructure/electron-ipc-module";
import { SessionGuard } from "../infrastructure/session.guard";
import { ProjectsController } from "./projects.controller";
import { IssuesController } from "./issues.controller";
import { ProjectsModule } from "./projects.module";

@IpcModule({
  controllers: [ProjectsController, IssuesController],
  imports: [ProjectsModule],
})
export class ProjectsIpcModule {}
```

```typescript
// projects.controller.ts
import { Controller, UseGuards } from "@spinejs/gateway-core";
import { SessionGuard } from "../infrastructure/session.guard";
import { handle } from "@spinejs/electron-ipc-gateway";
import { z } from "zod";

const createProjectSchema = z.object({ name: z.string().min(1) });

@UseGuards(SessionGuard)
@Controller({ inject: [ProjectsService] })
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  list = handle("projects:list", {}, (_input, ctx) =>
    this.projectsService.findAll(ctx.session.userId)
  );

  create = handle(
    "projects:create",
    { input: createProjectSchema },
    (input, ctx) => this.projectsService.create(ctx.session.userId, input.name)
  );
}
```

```typescript
// main.module.ts
import { Module } from "@spinejs/core";
import { ProjectsIpcModule } from "./projects.ipc.module";

@Module({
  imports: [ProjectsIpcModule],
})
export class MainModule {}
```

## Résolution des guards

Vous n'avez pas besoin de lister manuellement les classes de guard dans le tableau `providers`. À l'`onInit`, le module de fonctionnalité parcourt les instances de contrôleurs pour collecter chaque classe de guard référencée — `@UseGuards` de classe **et** options `guards` par route — et résout chacune depuis son propre container, en enregistrant à la volée une classe inconnue.

Les guards doivent tout de même déclarer leurs propres dépendances via `@Injectable` sur la classe du guard, et ces dépendances doivent être joignables depuis le container du module de fonctionnalité (exports de ses imports + providers) — le container les résout à travers la chaîne normale de providers. Un guard dont une dépendance n'est pas joignable échoue à l'`onInit` avec une erreur claire.
