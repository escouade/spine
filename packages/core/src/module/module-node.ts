import {
  normalizeProvider,
  Provider,
  ProviderEntry,
  sameToken,
  Token,
} from "../container";
import type { ModuleEntry } from "./module-decorator";

// `any[]` required to stay assignable from module classes with concrete constructors.
// No base class: a module is a plain class decorated with `@Module`.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type ModuleConstructor<T extends object = object> = new (
  ...args: any[]
) => T;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface ModuleDef<T extends ModuleConstructor = ModuleConstructor> {
  module: T;
  inject?: Token[];
  imports?: ModuleEntry[];
  exports?: Token[];
  providers?: ProviderEntry[];
}

/**
 * Build-time node of the module graph: a normalized, mutable `ModuleDef` plus its identity/fresh
 * flags and the appliers that accumulate a DynamicModule's extras (phase 1). The resolver turns
 * each node into a runtime `ModuleRef` (phase 2).
 */
export class ModuleNode<T extends ModuleConstructor = ModuleConstructor> {
  private readonly def: ModuleDef<T>;
  private readonly _identity: object;
  private readonly _fresh: boolean;

  // `identity` defaults to the class → single-instance-per-class (shared). A `fresh` module passes
  // its DynamicModule object as identity → one instance per `configure()` call.
  constructor(def: ModuleDef<T>, identity?: object, fresh = false) {
    this.def = this.clone(def);
    this._identity = identity ?? def.module;
    this._fresh = fresh;
  }

  // App.ts / ModuleRef read these fields directly.
  get module(): T {
    return this.def.module;
  }

  get moduleKey(): T {
    return this.def.module;
  }

  /** Dedup/memo/cycle/registry key: the class (single) or the DynamicModule object (fresh). */
  get identity(): object {
    return this._identity;
  }

  get fresh(): boolean {
    return this._fresh;
  }

  get inject(): Token[] | undefined {
    return this.def.inject;
  }
  get imports(): ModuleEntry[] | undefined {
    return this.def.imports;
  }
  get exports(): Token[] | undefined {
    return this.def.exports;
  }
  get providers(): ProviderEntry[] | undefined {
    return this.def.providers;
  }

  /** Upsert providers by token. Does not touch inject/imports. */
  private provide(...providers: Provider[]): this {
    // Normalize existing bare classes to compare by token.
    const merged: Provider[] = (this.def.providers ?? []).map(
      normalizeProvider
    );
    for (const p of providers) {
      const i = merged.findIndex((x) => sameToken(x.provide, p.provide));
      if (i >= 0) merged[i] = p;
      else merged.push(p);
    }
    this.def.providers = merged;
    return this;
  }

  /** Merges providers (by token) — used to apply a dynamic module. */
  addProviders(providers: ProviderEntry[]): this {
    return this.provide(...providers.map(normalizeProvider));
  }

  /** Adds imports — used to apply a dynamic module. */
  addImports(imports: ModuleEntry[]): this {
    this.def.imports = [...(this.def.imports ?? []), ...imports];
    return this;
  }

  /** Adds exports (dedup by token) — used to apply a dynamic module. */
  addExports(exports: Token[]): this {
    const merged = this.def.exports ? [...this.def.exports] : [];
    for (const t of exports) {
      if (!merged.some((x) => sameToken(x, t))) merged.push(t);
    }
    this.def.exports = merged;
    return this;
  }

  private clone(def: ModuleDef<T>): ModuleDef<T> {
    return {
      module: def.module,
      inject: def.inject ? [...def.inject] : undefined,
      imports: def.imports ? [...def.imports] : undefined,
      exports: def.exports ? [...def.exports] : undefined,
      providers: def.providers ? [...def.providers] : undefined,
    };
  }
}
