# @spinejs/electron

Electron lifecycle integration for SpineJS. Manages `BrowserWindow` creation, Electron app events, and graceful shutdown.

## Quick start

Add `ElectronModule.configure(...)` to your app and pass `handleProcessExit: false` — Electron controls process exit.

```typescript
// main.ts
import { App } from "@spinejs/core";
import { ElectronModule } from "@spinejs/electron";
import { MainModule } from "./main.module";

const app = new App(
  [
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
    }),
    MainModule,
  ],
  { handleProcessExit: false } // required with ElectronModule
);

await app.init();
await app.start();
```

The window is **not** created automatically. Call `createMainWindow()` explicitly — typically after restoring auth or other startup state:

```typescript
// main.module.ts
import { Module, OnInit } from "@spinejs/core";
import { ElectronModule } from "@spinejs/electron";

@Module({
  imports: [
    ElectronModule.configure({
      /* … */
    }),
    AuthModule,
  ],
  inject: [ElectronModule, AuthService],
})
export class MainModule implements OnInit {
  constructor(
    private readonly electron: ElectronModule,
    private readonly auth: AuthService
  ) {}

  async onInit() {
    await this.auth.restore().catch(() => undefined);
    this.electron.createMainWindow();
  }
}
```

## `WindowService`

Owns the `BrowserWindow`. Inject it to drive the window from anywhere:

```typescript
import { Injectable } from "@spinejs/core";
import { WindowService } from "@spinejs/electron";

@Injectable({ inject: [WindowService] })
export class TrayService {
  constructor(private readonly window: WindowService) {}

  focus() {
    this.window.getMainWindow()?.show();
  }
}
```

Window bounds (position + size) are persisted to `userData/window-state.json` on `resize`/`move` (debounced 300 ms) and restored on the next launch.

## Graceful shutdown

`ElectronModule` intercepts `before-quit` to run SpineJS's shutdown chain before Electron exits:

```
Electron 'before-quit'
  → event.preventDefault()
  → app.stop()          (all onStop() hooks)
  → electronApp.quit()  (now let Electron quit)
```

Always pass `handleProcessExit: false` to `new App(…)` to avoid double-shutdown races.

## Reference

### `ElectronModuleOptions`

| Field         | Type                              | Description                                                           |
| ------------- | --------------------------------- | --------------------------------------------------------------------- |
| `window`      | `BrowserWindowConstructorOptions` | Passed to `new BrowserWindow(…)`. Persisted bounds are merged on top. |
| `devUrl`      | `string`                          | URL loaded when `app.isPackaged === false` (Vite dev server).         |
| `packagePath` | `string`                          | Path to the bundled renderer HTML, loaded in production.              |

**macOS:** `window-all-closed` does not quit; the `activate` event (Dock click, no open window) re-creates the main window automatically.

## Full docs

[apps/docs-site/docs/electron/electron-module](../../apps/docs-site/docs/electron/electron-module.md)
