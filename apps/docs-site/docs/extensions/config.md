---
sidebar_position: 1
---

# Config

`@spinejs/config` provides typed, async-capable configuration loading on top of SpineJS's module system. It uses phantom types to bind a configuration key to its value type at compile time, so `ConfigService.get(key)` returns the precise type without any casting.

## Installation

`ConfigModule` is a standard SpineJS module. Import it via its `configure()` factory:

```typescript
import { ConfigModule } from "@spinejs/config";

@Module({
  imports: [
    ConfigModule.configure({
      configs: [appConfig, databaseConfig],
    }),
  ],
})
export class AppModule {}
```

## `configKey<T>(description)`

Creates a typed `ConfigKey<T>`. The `T` phantom type flows through to every `ConfigService.get()` call that uses the key.

```typescript
import { configKey } from "@spinejs/config";

// Keys are typically defined alongside their configuration provider.
export const jwtSecretKey = configKey<string>("jwt.secret");
export const apiBaseUrlKey = configKey<string>("api.baseUrl");
export const windowBoundsKey = configKey<WindowBounds>("window.bounds");
```

Under the hood, `configKey` uses `Symbol.for(description)`, so the key is globally unique per description string and survives module reload (important in development).

## `ConfigProvider<T>`

A `ConfigProvider` pairs a `ConfigKey<T>` with an async or sync factory:

```typescript
import { configKey, ConfigProvider } from "@spinejs/config";
import { readFileSync } from "node:fs";

export const jwtSecretKey = configKey<string>("jwt.secret");

export const jwtConfig: ConfigProvider<string> = {
  key: jwtSecretKey,
  config: () =>
    process.env.JWT_SECRET ?? readFileSync(".jwt-secret", "utf-8").trim(),
};
```

The factory is called once during `ConfigModule.onInit()` and the result is stored. Async factories are awaited in declaration order.

## `ConfigModule.configure({ configs })`

```typescript
import { ConfigModule } from "@spinejs/config";
import { jwtConfig, dbConfig } from "./config";

ConfigModule.configure({ configs: [jwtConfig, dbConfig] });
```

`ConfigModuleOptions.configs` accepts an array of `ConfigProvider<any>`. Providers are loaded sequentially in array order, so you can sequence async initializations that depend on earlier values:

```typescript
export const rawCredentialsKey = configKey<RawCredentials>("credentials.raw");
export const encryptedKeyKey = configKey<Buffer>("credentials.key");

const credentialsConfig: ConfigProvider<RawCredentials> = {
  key: rawCredentialsKey,
  config: () => loadCredentials(), // async
};

const encryptedKeyConfig: ConfigProvider<Buffer> = {
  key: encryptedKeyKey,
  // Runs after rawCredentials is loaded.
  config: async () => {
    const creds = configService.get(rawCredentialsKey);
    return deriveKey(creds.masterPassword);
  },
};
```

## `ConfigService.get<T>(key: ConfigKey<T>): T`

Retrieves a loaded value by key. The return type is inferred from the key's phantom type:

```typescript
import { ConfigService } from "@spinejs/config";
import { jwtSecretKey, apiBaseUrlKey } from "./config";

@Injectable({ inject: [ConfigService] })
export class AuthService {
  constructor(private readonly config: ConfigService) {}

  createToken(payload: object): string {
    const secret = this.config.get(jwtSecretKey); // typed: string
    return jwt.sign(payload, secret);
  }
}
```

Calling `get()` before `ConfigModule.onInit()` completes throws because the key has not been loaded yet. Always ensure `ConfigModule` is initialized before depending on `ConfigService`.

## Async configuration factories

Configuration factories may be async. Common use cases:

```typescript
import { safeStorage } from "electron";

// Decrypt a value stored in the OS credential store.
export const llmApiKeyKey = configKey<string>("llm.apiKey");

export const llmConfig: ConfigProvider<string> = {
  key: llmApiKeyKey,
  config: async () => {
    const encrypted = await getEncryptedFromUserData("llm-api-key");
    return safeStorage.decryptString(encrypted);
  },
};
```

## Full example

```typescript
// config/main.config.ts
import { configKey, ConfigProvider } from "@spinejs/config";
import { safeStorage } from "electron";

export const apiBaseUrlKey = configKey<string>("api.baseUrl");
export const llmApiKeyKey = configKey<string>("llm.apiKey");

interface AppConfig {
  apiBaseUrl: string;
}

export const mainConfig: ConfigProvider<AppConfig> = {
  key: configKey<AppConfig>("app.main"),
  config: () => ({
    apiBaseUrl: process.env.API_BASE_URL ?? "http://localhost:3000",
  }),
};
```

```typescript
// modules/main.module.ts
import { Module } from "@spinejs/core";
import { ConfigModule } from "@spinejs/config";
import { mainConfig } from "../../config/main.config";

@Module({
  imports: [ConfigModule.configure({ configs: [mainConfig] })],
})
export class MainModule {}
```

```typescript
// modules/api.service.ts
import { Injectable } from "@spinejs/core";
import { ConfigService } from "@spinejs/config";
import { apiBaseUrlKey } from "../../config/main.config";

@Injectable({ inject: [ConfigService] })
export class ApiService {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.get(apiBaseUrlKey); // string — typed from configKey<string>
  }
}
```
