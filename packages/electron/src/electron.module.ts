import {
  App,
  appToken,
  DynamicModule,
  InjectionToken,
  Logger,
  loggerToken,
  Module,
  OnInit,
} from "@spinejs/core";
import { app as electronApp, BrowserWindow } from "electron";
import { ElectronModuleOptions } from "./electron.types";
import { WindowService, windowServiceProvider } from "./window.service";

export const electronModuleOptionsToken =
  new InjectionToken<ElectronModuleOptions>("electron.module-options");

@Module({
  inject: [appToken, loggerToken, electronModuleOptionsToken, WindowService],
  providers: [windowServiceProvider],
  exports: [WindowService, electronModuleOptionsToken],
})
export class ElectronModule implements OnInit {
  private shuttingDown = false;
  private mainWindowRequested = false;

  constructor(
    private readonly appInstance: App,
    private readonly logger: Logger,
    private readonly options: ElectronModuleOptions,
    private readonly windowService: WindowService
  ) {}

  async onInit(): Promise<void> {
    await electronApp.whenReady();

    electronApp.on("window-all-closed", () => {
      if (process.platform !== "darwin") electronApp.quit();
    });

    // Registered once here — registering it inside createMainWindow() would add a
    // new listener on every call (each macOS re-activation would stack another).
    // Only re-creates once the app has explicitly opened its window.
    electronApp.on("activate", () => {
      if (
        this.mainWindowRequested &&
        BrowserWindow.getAllWindows().length === 0
      ) {
        this.createMainWindow();
      }
    });

    electronApp.on("before-quit", (event) => {
      if (this.shuttingDown) return;
      this.logger.info(
        "Electron triggered quit, shutting down application...",
        ElectronModule.name
      );
      event.preventDefault();
      this.shuttingDown = true;
      this.appInstance
        .stop()
        .catch((err) => this.logger.error(err, ElectronModule.name))
        .finally(() => electronApp.quit());
    });
  }

  createMainWindow(): void {
    this.mainWindowRequested = true;
    this.windowService.createMainWindow(
      this.options.window,
      this.options.devUrl,
      this.options.packagePath
    );
  }

  static configure(options: ElectronModuleOptions): DynamicModule {
    return {
      module: ElectronModule,
      providers: [{ provide: electronModuleOptionsToken, value: options }],
    };
  }
}
