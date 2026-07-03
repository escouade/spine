// Public API of @spinejs/config (explicit re-exports, no wild export *).
export {
  ConfigModule,
  configModuleOptionsToken,
  configKey,
} from "./config.module";
export { ConfigService, configServiceProvider } from "./config.service";
export type {
  ConfigProvider,
  ConfigKey,
  ConfigValue,
  ConfigModuleOptions,
} from "./types";
