---
sidebar_position: 1
---

# Module Electron

`@spinejs/electron` intègre le cycle de vie applicatif d'Electron dans le système de modules et de cycle de vie de SpineJS. Il gère la création de `BrowserWindow`, les événements de l'app Electron et l'arrêt propre — en garantissant que la séquence de quit d'Electron déclenche la chaîne `stop()` de SpineJS avant la fin du process.

## `ElectronModule`

`ElectronModule` est un module SpineJS qui enveloppe l'objet `app` d'Electron. Il gère :

- L'attente de `electronApp.whenReady()` avant de signaler la disponibilité.
- L'enregistrement de `window-all-closed` pour quitter (hors macOS) quand toutes les fenêtres se ferment.
- L'interception de `before-quit` pour exécuter l'arrêt propre de SpineJS avant qu'Electron ne termine le process.

### `ElectronModule.configure(options)`

Le module est toujours consommé via sa factory `DynamicModule` :

```typescript
import { ElectronModule } from "@spinejs/electron";

ElectronModule.configure({
  window: {
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  },
  devUrl: "http://localhost:5173",
  packagePath: join(__dirname, "../renderer/index.html"),
});
```

### `ElectronModuleOptions`

| Champ         | Type                              | Description                                                                                                                                                          |
| ------------- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window`      | `BrowserWindowConstructorOptions` | Passé directement à `new BrowserWindow(...)`. Les bornes de la fenêtre (position et taille) sont persistées entre les sessions et fusionnées par-dessus ces options. |
| `devUrl`      | `string`                          | URL chargée en développement (`app.isPackaged === false` et `E2E_LOAD_FILE !== '1'`). Typiquement votre serveur de dev Vite.                                         |
| `packagePath` | `string`                          | Chemin vers le fichier HTML du renderer bundlé, chargé en production.                                                                                                |

## Création de la fenêtre

`ElectronModule` ne crée pas la fenêtre automatiquement pendant `onInit()`. Il attend que le module parent appelle explicitement `createMainWindow()`. Cela donne à l'application le contrôle du moment où la fenêtre apparaît — par exemple, après la restauration de l'authentification :

```typescript
import { Module, OnInit } from "@spinejs/core";
import { ElectronModule } from "@spinejs/electron";

@Module({
  imports: [
    ElectronModule.configure({
      /* ... */
    }),
    AuthModule,
  ],
  inject: [ElectronModule, AuthService],
})
export class MainModule implements OnInit {
  constructor(
    private readonly electronModule: ElectronModule,
    private readonly authService: AuthService
  ) {}

  async onInit(): Promise<void> {
    // Restore persisted auth token before showing the window.
    await this.authService.restore().catch(() => undefined);

    // Now open the window.
    this.electronModule.createMainWindow();
  }
}
```

## `WindowService`

`WindowService` détient l'instance `BrowserWindow` et gère la persistance des bornes de la fenêtre.

### Injection de constructeur

```typescript
// windowServiceProvider is exported for convenience.
// It is already included in ElectronModule's providers.
import { WindowService, windowServiceToken } from "@spinejs/electron";
```

### `createMainWindow(windowOptions, devUrl, packagePath)`

Crée la `BrowserWindow` avec les options données, fusionnées avec les dernières bornes persistées (position + taille). Charge :

- `devUrl` en développement (quand `app.isPackaged === false` et `E2E_LOAD_FILE !== '1'`).
- `packagePath` en production.

Persiste les bornes de la fenêtre dans `userData/window-state.json` sur les événements `resize` et `move` (debouncé à 300 ms).

### `getMainWindow()`

Retourne la `BrowserWindow` active, ou `null` si la fenêtre a été fermée.

```typescript
@Injectable({ inject: [WindowService] })
export class TrayService {
  constructor(private readonly windowService: WindowService) {}

  focusWindow(): void {
    const win = this.windowService.getMainWindow();
    if (win) {
      win.show();
      win.focus();
    }
  }
}
```

## Intégration de l'arrêt propre

`ElectronModule` intercepte `app.on('before-quit')` pour exécuter la séquence d'arrêt de SpineJS avant qu'Electron ne termine :

```
Electron 'before-quit' event
  └─ event.preventDefault()    ← hold Electron from quitting
  └─ appInstance.stop()        ← run all onStop() hooks
  └─ electronApp.quit()        ← now let Electron quit for real
```

Cela garantit que les services dotés d'implémentations `onStop()` (connexions base de données, vidages de fichiers, flux ouverts) terminent leur nettoyage avant la fin du process.

:::warning Désactivez `handleProcessExit` sous Electron
Lorsque vous utilisez `ElectronModule`, passez `handleProcessExit: false` à `new App(...)`. Electron contrôle la sortie du process via `app.quit()` — les écouteurs SIGINT/SIGTERM par défaut de SpineJS entreraient en course avec la séquence de quit d'Electron.

```typescript
const app = new App(
  [
    ElectronModule.configure({
      /* ... */
    }),
    MainModule,
  ],
  {
    handleProcessExit: false,
  }
);
```

:::

## `electronModuleOptionsToken`

Le token d'options est exporté pour les cas où un autre module a besoin de lire la configuration de la fenêtre :

```typescript
import { electronModuleOptionsToken } from "@spinejs/electron";

@Module({ inject: [electronModuleOptionsToken] })
export class DeepLinkModule {
  constructor(private readonly options: ElectronModuleOptions) {}
}
```

## Comportement spécifique à macOS

`window-all-closed` n'appelle pas `app.quit()` sous macOS (la convention standard macOS est de garder l'application active dans le Dock jusqu'à ce que l'utilisateur quitte explicitement). L'événement `activate` (clic sur le Dock sans fenêtre ouverte) recrée la fenêtre principale :

```typescript
// Inside ElectronModule.createMainWindow():
electronApp.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) this.createMainWindow();
});
```

C'est géré automatiquement — aucune configuration nécessaire.
