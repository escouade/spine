import {
  DynamicModule,
  InjectionToken,
  Module,
  OnInit,
  Provider,
} from "@spinejs/core";

import { ConfigService, configServiceProvider } from "./config.service";
import { ConfigKey, ConfigModuleOptions } from "./types";

/** Creates a typed config key. The `T` propagates down to `ConfigService.get(key)`. */
export function configKey<T>(description: string): ConfigKey<T> {
  return Symbol.for(description) as ConfigKey<T>;
}

export const configModuleOptionsToken = new InjectionToken<ConfigModuleOptions>(
  "config.module-options"
);

const configModuleOptionsProvider: Provider<ConfigModuleOptions> = {
  provide: configModuleOptionsToken,
  value: { configs: [] },
};

@Module({
  inject: [ConfigService, configModuleOptionsToken],
  providers: [configModuleOptionsProvider, configServiceProvider],
  exports: [ConfigService],
})
export class ConfigModule implements OnInit {
  constructor(
    private readonly configService: ConfigService,
    private readonly options: ConfigModuleOptions
  ) {}

  async onInit(): Promise<void> {
    await this.configService.loadConfigs(this.options.configs);
  }

  /** Configures the module at import: `imports: [ConfigModule.configure({ configs })]`. */
  static configure(options: ConfigModuleOptions): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: configModuleOptionsToken, value: options }],
    };
  }
}
