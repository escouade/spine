---
sidebar_position: 1
---

# Electron Module

`@spinejs/electron` integrates Electron's application lifecycle into SpineJS's module and lifecycle system. It manages `BrowserWindow` creation, Electron app events, and graceful shutdown — ensuring that Electron's quit sequence triggers SpineJS's `stop()` chain before the process exits.

## `ElectronModule`

`ElectronModule` is an SpineJS module that wraps the Electron `app` object. It handles:

- Waiting for `electronApp.whenReady()` before signaling ready.
- Registering `window-all-closed` to quit on non-macOS when all windows close.
- Intercepting `before-quit` to run SpineJS's graceful shutdown before Electron terminates the process.

### `ElectronModule.configure(options)`

The module is always consumed via its `DynamicModule` factory:

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

| Field         | Type                              | Description                                                                                                                                          |
| ------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `window`      | `BrowserWindowConstructorOptions` | Passed directly to `new BrowserWindow(...)`. Window bounds (position and size) are persisted between sessions and merged in on top of these options. |
| `devUrl`      | `string`                          | URL loaded in development (`app.isPackaged === false` and `E2E_LOAD_FILE !== '1'`). Typically your Vite dev server.                                  |
| `packagePath` | `string`                          | Path to the bundled renderer HTML file, loaded in production.                                                                                        |

## Window creation

`ElectronModule` does not create the window automatically during `onInit()`. It waits for the parent module to call `createMainWindow()` explicitly. This gives the app control over when the window appears — for example, after authentication is restored:

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

`WindowService` owns the `BrowserWindow` instance and handles window bounds persistence.

### Constructor injection

```typescript
// windowServiceProvider is exported for convenience.
// It is already included in ElectronModule's providers.
import { WindowService, windowServiceToken } from "@spinejs/electron";
```

### `createMainWindow(windowOptions, devUrl, packagePath)`

Creates the `BrowserWindow` with the given options, merged with the last persisted bounds (position + size). Loads:

- `devUrl` in development (when `app.isPackaged === false` and `E2E_LOAD_FILE !== '1'`).
- `packagePath` in production.

Persists the window bounds to `userData/window-state.json` on `resize` and `move` events (debounced at 300 ms).

### `getMainWindow()`

Returns the active `BrowserWindow`, or `null` if the window has been closed.

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

## Graceful shutdown integration

`ElectronModule` intercepts `app.on('before-quit')` to run SpineJS's shutdown sequence before Electron terminates:

```
Electron 'before-quit' event
  └─ event.preventDefault()    ← hold Electron from quitting
  └─ appInstance.stop()        ← run all onStop() hooks
  └─ electronApp.quit()        ← now let Electron quit for real
```

This guarantees that services with `onStop()` implementations (database connections, file flushes, open streams) complete their cleanup before the process exits.

:::warning Disable `handleProcessExit` in Electron
When using `ElectronModule`, pass `handleProcessExit: false` to `new App(...)`. Electron controls the process exit via `app.quit()` — the default SIGINT/SIGTERM listeners in SpineJS would race with the Electron quit sequence.

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

The options token is exported for cases where another module needs to read the window configuration:

```typescript
import { electronModuleOptionsToken } from "@spinejs/electron";

@Module({ inject: [electronModuleOptionsToken] })
export class DeepLinkModule {
  constructor(private readonly options: ElectronModuleOptions) {}
}
```

## macOS-specific behavior

`window-all-closed` does not call `app.quit()` on macOS (the standard macOS convention is to keep the app running in the Dock until the user explicitly quits). The `activate` event (Dock click with no open windows) re-creates the main window:

```typescript
// Inside ElectronModule.createMainWindow():
electronApp.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) this.createMainWindow();
});
```

This is handled automatically — no configuration needed.
