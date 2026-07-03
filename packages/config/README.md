# @spinejs/config

Typed, async-capable configuration loading for SpineJS. Phantom types bind a config key to its value type at compile time — `ConfigService.get(key)` returns the precise type without casting.

## Quick start

Define keys → providers → register → inject and use.

```typescript
import { Injectable, Module } from "@spinejs/core";
import {
  configKey,
  ConfigProvider,
  ConfigModule,
  ConfigService,
} from "@spinejs/config";

// 1. Typed keys
export const apiUrlKey = configKey<string>("api.url");

// 2. Providers
export const apiConfig: ConfigProvider<string> = {
  key: apiUrlKey,
  config: () => process.env.API_URL ?? "http://localhost:3000",
};

// 3. Register in the module graph
@Module({ imports: [ConfigModule.configure({ configs: [apiConfig] })] })
export class AppModule {}

// 4. Inject and use — get() is typed as string, no cast
@Injectable({ inject: [ConfigService] })
export class ApiService {
  constructor(private readonly config: ConfigService) {}
  fetch() {
    const url = this.config.get(apiUrlKey);
  }
}
```

## Async factories

The factory runs once during `ConfigModule.onInit()`. Providers load **sequentially** in declaration order, so a later provider can read an earlier value via `configService.get(earlierKey)` inside its factory:

```typescript
export const llmApiKeyKey = configKey<string>("llm.apiKey");

export const llmConfig: ConfigProvider<string> = {
  key: llmApiKeyKey,
  config: async () => {
    const encrypted = await readEncrypted("llm-api-key");
    return safeStorage.decryptString(encrypted); // Electron safeStorage
  },
};
```

## Reference

- **`configKey<T>(description)`** — creates a typed `ConfigKey<T>` backed by `Symbol.for(description)`. Same description → same key.
- **`ConfigProvider<T>`** — `{ key: ConfigKey<T>; config: () => T | Promise<T> }`.
- **`ConfigModule.configure({ configs })`** — registers the providers; they load in order.
- **`ConfigService.get<T>(key: ConfigKey<T>): T`** — returns the loaded value, precisely typed.

## Full docs

[apps/docs-site/docs/extensions/config](../../apps/docs-site/docs/extensions/config.md)
