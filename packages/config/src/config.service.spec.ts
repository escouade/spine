import { ConfigService } from "./config.service";
import type { ConfigKey, ConfigProvider } from "./types";

// `configKey` vit dans config.module.ts (qui importe app-core/emittery, ESM-only).
// We reproduce its semantics here — `Symbol.for(description)` — to keep this spec
// libre de tout import de Module/App.
const key = <T>(description: string): ConfigKey<T> =>
  Symbol.for(description) as ConfigKey<T>;

describe("ConfigService", () => {
  it("loads providers and returns their resolved values, type-inferred from the key", async () => {
    const apiKey = key<{ apiBaseUrl: string }>("test:api");
    const provider: ConfigProvider<{ apiBaseUrl: string }> = {
      key: apiKey,
      config: () => ({ apiBaseUrl: "http://localhost:3900" }),
    };

    const service = new ConfigService();
    await service.loadConfigs([provider]);

    expect(service.get(apiKey).apiBaseUrl).toBe("http://localhost:3900");
  });

  it("awaits async config factories", async () => {
    const tokenKey = key<string>("test:token");
    const provider: ConfigProvider<string> = {
      key: tokenKey,
      config: async () => "resolved",
    };

    const service = new ConfigService();
    await service.loadConfigs([provider]);

    expect(service.get(tokenKey)).toBe("resolved");
  });

  it("throws for an unknown key", () => {
    const service = new ConfigService();
    expect(() => service.get(key("test:missing"))).toThrow(
      /Unknown config key/
    );
  });

  it("keys are stable across recreation (Symbol.for)", async () => {
    const service = new ConfigService();
    await service.loadConfigs([{ key: key("test:stable"), config: () => 42 }]);

    // A key recreated with the same description resolves the same value.
    expect(service.get(key<number>("test:stable"))).toBe(42);
  });
});
