import { app as electronApp, BrowserWindow, Rectangle } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InjectionToken, Logger, loggerToken, Provider } from "@spinejs/core";

export class WindowService {
  private mainWindow: BrowserWindow | null = null;
  private readonly boundsFilePath = join(
    electronApp.getPath("userData"),
    "window-state.json"
  );
  private saveBoundsTimer: NodeJS.Timeout | null = null;

  constructor(private readonly logger: Logger) {}

  createMainWindow(
    windowOptions: Electron.BrowserWindowConstructorOptions,
    devUrl: string,
    packagePath: string
  ): void {
    this.mainWindow = new BrowserWindow({
      ...windowOptions,
      ...this.loadBounds(),
    });

    if (electronApp.isPackaged || process.env.E2E_LOAD_FILE === "1") {
      void this.mainWindow.loadFile(packagePath);
    } else {
      void this.mainWindow.loadURL(devUrl);
    }

    const persist = () => this.scheduleSaveBounds();
    this.mainWindow.on("resize", persist);
    this.mainWindow.on("move", persist);
    this.mainWindow.on("closed", () => {
      this.mainWindow = null;
      this.logger.info("Main window closed", WindowService.name);
    });
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  private loadBounds(): Rectangle | undefined {
    try {
      return JSON.parse(
        readFileSync(this.boundsFilePath, "utf-8")
      ) as Rectangle;
    } catch {
      return undefined;
    }
  }

  private scheduleSaveBounds(): void {
    if (this.saveBoundsTimer) clearTimeout(this.saveBoundsTimer);
    this.saveBoundsTimer = setTimeout(() => this.saveBounds(), 300);
  }

  private saveBounds(): void {
    if (!this.mainWindow) return;
    try {
      writeFileSync(
        this.boundsFilePath,
        JSON.stringify(this.mainWindow.getBounds())
      );
    } catch (err) {
      this.logger.error(err, WindowService.name);
    }
  }
}

export const windowServiceToken = new InjectionToken<WindowService>(
  "electron.window-service"
);

export const windowServiceProvider: Provider<WindowService> = {
  provide: WindowService,
  inject: [loggerToken],
};
