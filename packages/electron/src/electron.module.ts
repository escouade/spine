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
    this.windowService.createMainWindow(
      this.options.window,
      this.options.devUrl,
      this.options.packagePath
    );
    electronApp.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) this.createMainWindow();
    });
  }

  static configure(options: ElectronModuleOptions): DynamicModule {
    return {
      module: ElectronModule,
      providers: [{ provide: electronModuleOptionsToken, value: options }],
    };
  }
}
