import type { ProviderEntry, ResolvedTuple, Token } from "../container";
import { defineOwnMeta, readOwnMeta } from "../utils";
import type { ModuleConstructor, ModuleNode } from "./module-node";

/** Metadata set by `@Module` on the class (read by App at startup). */
const MODULE_META = Symbol.for("app-core:module-meta");

export interface ModuleMetadata {
  /** Constructor deps of the module, injected in order (typed by `@Module`'s generic). */
  inject?: Token[];
  imports?: ModuleEntry[];
  providers?: ProviderEntry[];
  exports?: Token[];
}

/** Module configured on the fly (`configure` pattern): the class + extras to merge. */
export interface DynamicModule {
  module: ModuleConstructor;
  imports?: ModuleEntry[];
  providers?: ProviderEntry[];
  exports?: Token[];
  // Opt-in to a fresh instance per `configure()` call: identity becomes this object reference
  // (not the class), so two distinct configs yield two instances. Default (false) keeps the
  // single-instance-per-class model (shared, configs merged). A fresh module is reached through
  // its exported tokens, not by injecting its class.
  fresh?: boolean;
}

/** Anything that can go in `imports` / be passed to `App`. */
export type ModuleEntry = ModuleConstructor | DynamicModule | ModuleNode;

/**
 * Declares a module: its constructor deps (`inject`), imports, providers and exports.
 *
 * `D` is the tuple type of the `inject` array you pass in (e.g. `[typeof appToken, typeof loggerToken]`).
 * It's then fed into `ResolvedTuple<D>`, which maps each token to the type it resolves to, and that
 * result becomes the required constructor signature. So `inject: [appToken, loggerToken]` forces the
 * class constructor to be `(app: App, logger: Logger)` — same order, same types. Mismatch = compile
 * error. No `inject` (default `D = []`) means a no-arg constructor. The lifecycle is optional via
 * `OnInit`/`OnStop`.
 */
export function Module<const D extends readonly Token[] = []>(
  meta: ModuleMetadata & { inject?: D } = {}
) {
  return <C extends new (...args: ResolvedTuple<D>) => object>(cls: C): C => {
    defineOwnMeta(cls, MODULE_META, meta);
    return cls;
  };
}

/** Reads `@Module` metadata (own-property only). */
export function getModuleMetadata(cls: object): ModuleMetadata | undefined {
  return readOwnMeta<ModuleMetadata>(cls, MODULE_META);
}
