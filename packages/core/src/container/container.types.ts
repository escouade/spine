import { InjectionToken } from "./injection-token";

export type Token<T = unknown> = ProviderConstructor<T> | InjectionToken<T>;

/**
 * Lifecycle of a provider's instances.
 * - `singleton` (default): one cached instance per container.
 * - `transient`: a fresh instance on every resolution, never cached.
 */
export type ProviderScope = "singleton" | "transient";

export interface BaseProvider<T = unknown> {
  provide: Token<T>;
  inject?: Token[];
  scope?: ProviderScope;
}

// `any[]` is needed here: with `unknown[]`, a class/factory with concrete parameters
// is no longer assignable (argument contravariance).
/* eslint-disable @typescript-eslint/no-explicit-any */
export type ProviderConstructor<T = unknown> = new (...args: any[]) => T;
export type ProviderFactory<T = unknown> = (...args: any[]) => T;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface FactoryProvider<T = unknown> {
  provide: Token<T>;
  inject?: Token[];
  scope?: ProviderScope;
  factory: ProviderFactory<NoInfer<T>>;
}
export interface ValueProvider<T = unknown> {
  provide: Token<T>;
  value: NoInfer<T>;
}

export interface DelegateProvider<T = unknown> {
  provide: Token<T>;
  delegate: () => NoInfer<T>;
}

/** Pure alias: resolving `provide` resolves `existing` instead — same instance, same cache slot. */
export interface ExistingProvider<T = unknown> {
  provide: Token<T>;
  existing: Token<T>;
}

export type Provider<T = unknown> =
  | BaseProvider<T>
  | FactoryProvider<T>
  | ValueProvider<T>
  | DelegateProvider<T>
  | ExistingProvider<T>;

/**
 * Entry accepted in `providers: [...]`: either an explicit Provider, or a
 * **bare class** (`@Injectable` then carries its deps). `normalizeProvider`
 * converts it to `{ provide: Class }`.
 */
export type ProviderEntry<T = unknown> = Provider<T> | ProviderConstructor<T>;

/**
 * Effective Map key. A class is keyed on its *reference* (unique and stable under
 * minification); an InjectionToken on its unique `Symbol()` — i.e. also by identity, never
 * by description (see InjectionToken).
 */
export type TokenKey = ProviderConstructor | symbol;
