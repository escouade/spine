/**
 * *Typed* config key: a symbol carrying its value type as a phantom (`__config`).
 * The symbol stays the Map key at runtime (stable via `Symbol.for`); the phantom
 * exists only at the type level, and lets `ConfigService.get(key)` infer the return type.
 */
export type ConfigKey<T> = symbol & { readonly __config?: T };

/** Value type carried by a `ConfigKey`. */
export type ConfigValue<K> = K extends ConfigKey<infer T> ? T : never;

export interface ConfigProvider<T = unknown> {
  key: ConfigKey<T>;
  // `loadConfigs` does `await config()`: the factory may be sync or async.
  config: () => T | Promise<T>;
}

export interface ConfigModuleOptions {
  // `ConfigProvider<any>`: the list mixes providers of heterogeneous types.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  configs: ConfigProvider<any>[];
}
