/**
 * Simple timer based on performance.now() (high-resolution, ms).
 * Keyed by string by default; pass `K` (e.g. `object`) to key by an identity unique per instance
 * — a string name can collide where an object can't (fresh modules share a name).
 */
export class Timer<K = string> {
  private readonly times = new Map<K, number>();

  /** Start a timer. */
  start(id: K): void {
    this.times.set(id, performance.now());
  }

  /** Elapsed time (ms) since start, as a number. Source of truth. */
  elapsed(id: K, clean = true): number {
    const started = this.times.get(id);
    if (started === undefined) throw new Error("invalid timer id");

    if (clean) this.times.delete(id);
    return performance.now() - started;
  }

  /** Elapsed time (ms) since start, as a string with `precision` decimals. */
  getTime(id: K, precision = 3, clean = true): string {
    return this.elapsed(id, clean).toFixed(precision);
  }
}

/** True if `o` is an object literal. */
export function isObject(o: unknown): o is Record<string, unknown> {
  return o instanceof Object && o.constructor === Object;
}

/**
 * Stores decorator metadata on a class under a Symbol key: hidden (`enumerable: false`) and
 * re-definable (`configurable`/`writable`). Single source of truth for the descriptor flags used by
 * `@Module`/`@Injectable`.
 */
export function defineOwnMeta<T>(cls: object, key: symbol, value: T): void {
  Object.defineProperty(cls, key, {
    value,
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/**
 * Reads metadata set by `defineOwnMeta`. **Own-property only** (`hasOwnProperty`): a subclass must
 * NOT inherit its parent's metadata (e.g. a `class Child extends Module {}` without its own
 * `@Module` resolves to `undefined`, not the parent's providers).
 */
export function readOwnMeta<T>(cls: object, key: symbol): T | undefined {
  return Object.prototype.hasOwnProperty.call(cls, key)
    ? (cls as Record<symbol, T>)[key]
    : undefined;
}

/**
 * Deep merge of own enumerable properties of `sources` into `object`, **mutating and returning
 * `object`** (drop-in for `lodash.merge`, scoped to the surface this repo uses):
 * - plain objects and arrays are merged recursively; arrays merge by index (extra destination
 *   elements are kept);
 * - `undefined` source values are skipped (never overwrite an existing value with `undefined`);
 * - anything else (primitives, `Date`, class instances, functions) is assigned by reference, later
 *   source winning.
 *
 * Not replicated (unused here): `keysIn`/inherited keys, symbol keys, typed-array/Buffer cloning,
 * customizers. Reach for a real `lodash.merge` if those matter.
 */
export function merge<T>(object: T, ...sources: unknown[]): T {
  for (const source of sources) {
    if (isObject(source) || Array.isArray(source)) {
      mergeInto(object as Record<string | number, unknown>, source);
    }
  }
  return object;
}

function mergeInto(
  object: Record<string | number, unknown>,
  source: object
): Record<string | number, unknown> {
  for (const key of Object.keys(source)) {
    const srcValue = (source as Record<string, unknown>)[key];
    if (srcValue === undefined) continue;

    const objValue = object[key];
    if (Array.isArray(srcValue)) {
      const target = Array.isArray(objValue) ? objValue : [];
      object[key] = mergeInto(
        target as unknown as Record<number, unknown>,
        srcValue
      );
    } else if (isObject(srcValue)) {
      const target = isObject(objValue) ? objValue : {};
      object[key] = mergeInto(target as Record<string, unknown>, srcValue);
    } else if (objValue !== srcValue) {
      object[key] = srcValue;
    }
  }
  return object;
}
