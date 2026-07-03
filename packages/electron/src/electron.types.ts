import { BrowserWindowConstructorOptions } from "electron";

export interface ElectronModuleOptions {
  window: BrowserWindowConstructorOptions;
  devUrl: string;
  packagePath: string;
}
