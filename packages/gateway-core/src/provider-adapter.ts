import type {
  FactoryProvider,
  Provider,
  Token,
  ValueProvider,
} from "@spinejs/core";

/**
 * A provider whose token the module already fixes — what a transport's `configure()` accepts for
 * each port (validator, error mapper, context factory…) **without** repeating the internal token.
 * Pure derivation of the core `Provider` shapes minus `provide`, so it tracks the core (scope,
 * `NoInfer`, …) instead of re-declaring `factory`/`inject`/`value` by hand.
 */
export type ProviderAdapter<T> =
  | Omit<FactoryProvider<T>, "provide">
  | Omit<ValueProvider<T>, "provide">;

/** Pins the fixed `provide` token onto an adapter, yielding a full core `Provider`. */
export function toProvider<T>(
  provide: Token<T>,
  adapter: ProviderAdapter<T>
): Provider<T> {
  return { provide, ...adapter };
}
