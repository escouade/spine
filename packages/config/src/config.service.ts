import { Provider } from "@spinejs/core";
import type { ConfigKey, ConfigProvider } from "./types";

export class ConfigService {
  private readonly configs: Map<symbol, unknown> = new Map();

  constructor() {}

  // `ConfigProvider<any>`: heterogeneous values, each validated by its own `ConfigKey`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async loadConfigs(configs: ConfigProvider<any>[]) {
    for (const { key, config } of configs) {
      const resolved = await config();
      this.configs.set(key, resolved);
    }
  }

  get<T>(key: ConfigKey<T>): T {
    if (!this.configs.has(key)) {
      throw new Error(`Unknown config key ${String(key)} !`);
    }

    return this.configs.get(key) as T;
  }
}

export const configServiceProvider: Provider<ConfigService> = {
  provide: ConfigService,
};
