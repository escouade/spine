---
sidebar_position: 1
---

# Config

`@spinejs/config` fournit un chargement de configuration typé et asynchrone par-dessus le système de modules de SpineJS. Il utilise des types fantômes pour lier une clé de configuration à son type de valeur à la compilation, de sorte que `ConfigService.get(key)` retourne le type précis sans aucun cast.

## Installation

`ConfigModule` est un module SpineJS standard. Importez-le via sa factory `configure()` :

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

Crée une `ConfigKey<T>` typée. Le type fantôme `T` circule vers chaque appel `ConfigService.get()` qui utilise la clé.

```typescript
import { configKey } from "@spinejs/config";

// Keys are typically defined alongside their configuration provider.
export const jwtSecretKey = configKey<string>("jwt.secret");
export const apiBaseUrlKey = configKey<string>("api.baseUrl");
export const windowBoundsKey = configKey<WindowBounds>("window.bounds");
```

Sous le capot, `configKey` utilise `Symbol.for(description)`, donc la clé est globalement unique par chaîne de description et survit au rechargement de module (important en développement).

## `ConfigProvider<T>`

Un `ConfigProvider` apparie une `ConfigKey<T>` avec une factory asynchrone ou synchrone :

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

La factory est appelée une fois pendant `ConfigModule.onInit()` et le résultat est stocké. Les factories asynchrones sont attendues dans l'ordre de déclaration.

## `ConfigModule.configure({ configs })`

```typescript
import { ConfigModule } from "@spinejs/config";
import { jwtConfig, dbConfig } from "./config";

ConfigModule.configure({ configs: [jwtConfig, dbConfig] });
```

`ConfigModuleOptions.configs` accepte un tableau de `ConfigProvider<any>`. Les providers sont chargés séquentiellement dans l'ordre du tableau, vous pouvez donc séquencer des initialisations asynchrones qui dépendent de valeurs antérieures :

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

Récupère une valeur chargée par clé. Le type de retour est inféré du type fantôme de la clé :

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

Appeler `get()` avant la fin de `ConfigModule.onInit()` lève une erreur car la clé n'a pas encore été chargée. Assurez-vous toujours que `ConfigModule` est initialisé avant de dépendre de `ConfigService`.

## Factories de configuration asynchrones

Les factories de configuration peuvent être asynchrones. Cas d'usage courants :

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

## Exemple complet

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
