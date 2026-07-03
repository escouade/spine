---
sidebar_position: 1
---

# Transport IPC Electron

`@spinejs/electron-ipc-gateway` est le binding IPC Electron de `@spinejs/gateway-core`. Vous écrivez de simples controllers avec des routes `handle(channel, …)` ; le transport attache chacune à `ipcMain.handle(channel, ...)` pour qu'elle devienne un canal IPC actif.

Commencez par l'usage ci-dessous — la [référence](#référence) en bas couvre la classe et les types quand vous en avez besoin.

## Votre premier controller IPC

Enregistrez votre contexte d'app une fois, écrivez un controller, enregistrez-le.

### 1. Enregistrer votre contexte d'app

Augmentez le `IpcContextRegistry` **une seule fois** avec votre type de contexte — comme l'augmentation d'`Express.Request`. Il devient le `ctx` par défaut de chaque route, si bien que le `handle` importé depuis `@spinejs/electron-ipc-gateway` type `ctx` et infère l'`input` de chaque route sans factory par fichier.

```typescript
// electron-ipc.types.ts
import type { ElectronIpcBaseContext } from "@spinejs/electron-ipc-gateway";

export interface ElectronIpcContext extends ElectronIpcBaseContext {
  session: { userId: string };
}

declare module "@spinejs/electron-ipc-gateway" {
  interface IpcContextRegistry {
    context: ElectronIpcContext;
  }
}
```

:::caution
Sans cette augmentation, le `ctx` par défaut retombe sur `ElectronIpcBaseContext`, donc des champs applicatifs comme `ctx.session` n'existent pas. Déclarez-la **une fois par app**.
:::

### 2. Écrire le controller

Chaque route est un **champ d'instance**. Importez `handle` directement depuis `@spinejs/electron-ipc-gateway`. Le callback reçoit `(input, ctx)` : `input` est la charge utile validée, `ctx` vaut par défaut votre contexte. Retournez la valeur brute — la gateway l'emballe dans une enveloppe.

```typescript
import { Controller, UseGuards } from "@spinejs/gateway-core";
import { z } from "zod";
import { handle } from "@spinejs/electron-ipc-gateway";
import { SessionGuard } from "../infrastructure/session.guard";

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

### 3. L'enregistrer

Liez le controller à la gateway avec le sucre de feature-module — forme décorateur `@IpcModule` ou forme factory `ipcFeature({ … })` :

```typescript
// projects.ipc.module.ts
import { IpcModule } from "../infrastructure/electron-ipc-module";
import { ProjectsController } from "./projects.controller";
import { ProjectsModule } from "./projects.module";

@IpcModule({
  controllers: [ProjectsController],
  imports: [ProjectsModule],
})
export class ProjectsIpcModule {}
```

Côté renderer, invoquez le canal et discriminez sur l'enveloppe :

```typescript
const result = await ipcRenderer.invoke("projects:list");
if (result.ok) console.log(result.data);
else console.error(result.code); // p. ex. 'UNAUTHORIZED', 'SERVER'
```

Voir [Feature Modules](../gateway/feature-modules) pour les formes décorateur/factory et [Controllers et Routes](../gateway/controllers-handlers) pour l'ensemble de la surface de route.

## Câbler le module de transport

`ElectronIpcGatewayModule` est le module de transport. Il câble les trois ports et produit l'instance `ElectronIpcGateway`. Vous le construisez une fois par application et y placez tous ses adaptateurs spécifiques à l'app.

```typescript
import { Logger, loggerToken, Module, InjectionToken } from "@spinejs/core";
import { ContextFactory, ErrorMapper, Validator } from "@spinejs/gateway-core";
import { ElectronIpcGateway } from "@spinejs/electron-ipc-gateway";
import { ZodValidator } from "./zod.validator";
import { ElectronIpcErrorMapper } from "./electron-ipc-error.mapper";
import { SessionContextFactory } from "./session.context-factory";
import { SessionStore } from "../session";

const validatorToken = new InjectionToken<Validator>("validator");
const errorMapperToken = new InjectionToken<ErrorMapper<ErrorCode>>(
  "error-mapper"
);
const contextFactoryToken = new InjectionToken<
  ContextFactory<ElectronIpcRaw, ElectronIpcContext>
>("context-factory");

@Module({
  imports: [SessionModule],
  providers: [
    { provide: validatorToken, factory: () => new ZodValidator() },
    { provide: errorMapperToken, factory: () => new ElectronIpcErrorMapper() },
    {
      provide: contextFactoryToken,
      inject: [SessionStore],
      factory: (session: SessionStore) => new SessionContextFactory(session),
    },
    {
      provide: ElectronIpcGateway,
      inject: [
        validatorToken,
        errorMapperToken,
        contextFactoryToken,
        loggerToken,
      ],
      factory: (
        validator: ZodValidator,
        errorMapper: ElectronIpcErrorMapper,
        contextFactory: SessionContextFactory,
        logger: Logger
      ) =>
        new ElectronIpcGateway(validator, errorMapper, contextFactory, logger),
    },
  ],
  exports: [ElectronIpcGateway],
})
export class ElectronIpcGatewayModule {}
```

Liez les helpers de feature-module à cette gateway et ce module, une fois :

```typescript
// electron-ipc-module.ts
import {
  gatewayFeatureFactory,
  gatewayModuleDecorator,
} from "@spinejs/gateway-core";
import { ElectronIpcGateway } from "@spinejs/electron-ipc-gateway";
import { ElectronIpcGatewayModule } from "./electron-ipc-gateway.module";

export const ipcFeature = gatewayFeatureFactory(
  ElectronIpcGateway,
  ElectronIpcGatewayModule
);
export const IpcModule = gatewayModuleDecorator(
  ElectronIpcGateway,
  ElectronIpcGatewayModule
);
```

## Implémenter les ports

Les ports sont votre moyen d'injecter les préoccupations applicatives (contexte, codes d'erreur) sans que le transport les connaisse.

### `ContextFactory` — enrichir le contexte

Transforme l'événement Electron brut en un contexte typé que reçoivent vos controllers :

```typescript
import { ContextFactory } from "@spinejs/gateway-core";
import { ElectronIpcRaw } from "@spinejs/electron-ipc-gateway";

export interface ElectronIpcContext extends ElectronIpcBaseContext {
  session: Session | null;
}

export class SessionContextFactory
  implements ContextFactory<ElectronIpcRaw, ElectronIpcContext>
{
  constructor(private readonly sessionStore: SessionStore) {}

  create(raw: ElectronIpcRaw): ElectronIpcContext {
    return {
      event: raw.event,
      session: this.sessionStore.current(),
    };
  }
}
```

### `ErrorMapper` — mapper les erreurs vers des codes

Convertit toute erreur lancée en un code stable. Aucun message d'erreur brut n'atteint jamais le renderer :

```typescript
import {
  ErrorMapper,
  UnauthorizedError,
  ValidationError,
} from "@spinejs/gateway-core";

type ErrorCode =
  | "UNAUTHORIZED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "SERVER"
  | "NETWORK";

export class ElectronIpcErrorMapper implements ErrorMapper<ErrorCode> {
  toCode(err: unknown): ErrorCode {
    if (err instanceof ValidationError) return "INVALID_INPUT";
    if (err instanceof UnauthorizedError) return "UNAUTHORIZED";
    if (err instanceof NotFoundError) return "NOT_FOUND";
    if (err instanceof TypeError) return "NETWORK";
    return "SERVER";
  }
}
```

### Imposer l'auth avec un guard

Comme la `ContextFactory` enrichit déjà le contexte avec la session, un guard n'a plus qu'à la vérifier :

```typescript
import { Guard } from "@spinejs/gateway-core";
import { ElectronIpcContext } from "./electron-ipc.types";

export class SessionGuard implements Guard<ElectronIpcContext> {
  canActivate(ctx: ElectronIpcContext): boolean {
    return ctx.session !== null;
  }
}
```

Appliqué via `@UseGuards(SessionGuard)` sur un controller (comme dans le premier exemple), chaque route a la garantie `ctx.session !== null`. Voir [Guards](../gateway/guards).

## Exemple d'application complet

```typescript
// main.ts
import { App } from "@spinejs/core";
import { ElectronModule } from "@spinejs/electron";
import { ConfigModule } from "@spinejs/config";
import { MainModule } from "./modules/main.module";

const app = new App(
  [
    ConfigModule.configure({ configs: [appConfig] }),
    ElectronModule.configure({
      window: {
        width: 1280,
        height: 800,
        webPreferences: {
          preload: join(__dirname, "preload.js"),
          contextIsolation: true,
        },
      },
      devUrl: "http://localhost:5173",
      packagePath: join(__dirname, "../renderer/index.html"),
    }),
    MainModule,
  ],
  { handleProcessExit: false }
);

await app.init();
await app.start();
```

```typescript
// main.module.ts
import { Module, OnInit } from "@spinejs/core";
import { ElectronModule } from "@spinejs/electron";
import { ipcFeature, IpcModule } from "./infrastructure/electron-ipc-module";
import { HealthController } from "./interface/health.controller";
import { ProjectsModule } from "./domain/projects.module";
import { AuthModule } from "./domain/auth.module";

@Module({
  imports: [
    ElectronModule,
    AuthModule,
    ProjectsModule,
    // Forme factory — inline, pas de classe nommée :
    ipcFeature({ controllers: [HealthController] }),
    // Forme décorateur — module nommé :
    ProjectsIpcModule,
    AuthIpcModule,
  ],
  inject: [ElectronModule],
})
export class MainModule implements OnInit {
  constructor(private readonly electronModule: ElectronModule) {}

  async onInit(): Promise<void> {
    this.electronModule.createMainWindow();
  }
}
```

## Référence

### `ElectronIpcGateway`

```typescript
class ElectronIpcGateway<
  Ctx extends ElectronIpcBaseContext = ElectronIpcBaseContext,
  Code extends string = string,
>
```

La gateway **compose** un `DispatchPipeline` (elle n'étend pas de classe de base) et possède `register`/`bind`. Elle est agnostique de l'application : elle connaît `ipcMain` et l'événement Electron, mais rien des sessions ou des utilisateurs. Les préoccupations applicatives sont injectées via le port `ContextFactory`.

#### Constructeur

```typescript
new ElectronIpcGateway(
  validator: Validator,
  errorMapper: ErrorMapper<Code>,
  contextFactory: ContextFactory<ElectronIpcRaw, Ctx>,
  logger: Logger,
  interceptors?: GatewayInterceptor<Ctx, Code>[],
)
```

Le constructeur est appelé via un factory provider — la classe elle-même n'a pas de décorateur `@Injectable`, ce qui la garde générique vis-à-vis du transport.

#### Types

```typescript
// Contexte de base — toujours disponible.
interface ElectronIpcBaseContext extends GatewayContext {
  event: IpcMainInvokeEvent;
}

// Données brutes de l'appel passées à la ContextFactory.
interface ElectronIpcRaw {
  event: IpcMainInvokeEvent;
  args: unknown[];
}
```

### Normalisation de l'input brut

Quand `ipcRenderer.invoke(channel, arg1)` envoie un seul argument, la gateway passe `arg1` directement comme `rawInput`. Quand plusieurs arguments sont envoyés (`ipcRenderer.invoke(channel, arg1, arg2)`), ils sont passés en tableau `[arg1, arg2]`. Concevez votre schéma et votre handler en conséquence.

:::tip Convention à un seul argument
Tenez-vous-en à un seul argument objet par appel IPC. Cela se mappe proprement sur un schéma objet zod et évite l'ambiguïté du tableau. Par exemple : `ipcRenderer.invoke('users:create', { name: 'Alice', email: 'alice@example.com' })`.
:::
