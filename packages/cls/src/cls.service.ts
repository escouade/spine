import { AsyncLocalStorage } from "node:async_hooks";

/** A per-scope key→value store. Apps narrow it with their own keys. */
export type ClsStore = Record<string, unknown>;

/**
 * Continuation-Local Storage: the single owner of one `AsyncLocalStorage`, exposed as an injectable
 * singleton. `run()` opens a scope (one per request / dispatch / job); any code in that async call
 * chain reads and writes the same store through `get`/`set`, with nothing threaded through the
 * signatures. Two concurrent `run()`s get isolated stores — the binding is to the async execution
 * context, not to an instance — so the singleton stays shared while the data stays per-scope.
 *
 * Generic over the store shape `T`: untyped by default (`ClsService` = `ClsService<ClsStore>`), or an
 * app narrows it — `class DispatchContext extends ClsService<AppStore> {}` — for key-checked
 * `get`/`set`, aliased to the same singleton via an `existing` provider (no instantiation, no
 * wrapper object: same instance, just re-typed).
 */
export class ClsService<T extends object = ClsStore> {
  private readonly als = new AsyncLocalStorage<ClsStore>();

  /** Opens a fresh scope seeded with a copy of `seed`, runs `fn` inside it, returns its result. */
  run<R>(seed: T, fn: () => R): R {
    return this.als.run({ ...seed } as ClsStore, fn);
  }

  /** True when called inside an active `run()` scope. */
  get active(): boolean {
    return this.als.getStore() !== undefined;
  }

  /** Reads `key` from the active scope; `undefined` if absent or called outside any scope. */
  get<K extends keyof T & string>(key: K): T[K] | undefined {
    return this.als.getStore()?.[key] as T[K] | undefined;
  }

  /** Writes `key` into the active scope. Throws outside a scope — there is nothing to write to. */
  set<K extends keyof T & string>(key: K, value: T[K]): void {
    const store = this.als.getStore();
    if (!store) {
      throw new Error(
        `ClsService.set("${key}") called outside an active scope. Open one with run().`
      );
    }
    store[key] = value;
  }

  /** True when `key` exists in the active scope. */
  has(key: keyof T & string): boolean {
    const store = this.als.getStore();
    return store !== undefined && key in store;
  }
}
