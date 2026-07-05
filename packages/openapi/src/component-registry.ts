import type { JsonSchemaObject } from "@spinejs/gateway-core";

/** How a schema fragment is registered as a `components/schemas` entry. */
export interface RegisterOptions {
  /** Authored name from zod `.meta({ id })` — reserved and takes precedence (AD-8). */
  authoredId?: string;
  /** Fallback base name when there is no authored id, e.g. `CreateUser_Body`. */
  derivedBase: string;
}

/**
 * The builder's **sole component registry** (AD-8). Registers schema fragments as `components/schemas`
 * entries and hands back their `#/components/schemas/<name>` `$ref`. Naming: an authored `.meta({ id })`
 * wins and is reserved; otherwise the `<PascalCase operationId>_<source>` derived base is used, suffixed
 * `_2`/`_3`… when a *different* schema already holds the name. An identical schema under the same name
 * is deduplicated (one component). Components are emitted in sorted key order (AD-6).
 */
export class ComponentRegistry {
  private readonly schemas = new Map<string, JsonSchemaObject>();
  private readonly reserved = new Set<string>();

  /** Register `fragment` and return its `#/components/schemas/<name>` reference. */
  register(fragment: JsonSchemaObject, options: RegisterOptions): string {
    const authored = options.authoredId !== undefined;
    if (options.authoredId !== undefined) this.reserved.add(options.authoredId);
    const base = options.authoredId ?? options.derivedBase;
    const name = this.claim(base, fragment, authored);
    return `#/components/schemas/${name}`;
  }

  /** The `components.schemas` object in sorted key order, or `undefined` when empty (keep the doc clean). */
  toSchemas(): { [name: string]: JsonSchemaObject } | undefined {
    if (this.schemas.size === 0) return undefined;
    const sorted: { [name: string]: JsonSchemaObject } = {};
    for (const key of [...this.schemas.keys()].sort()) {
      sorted[key] = this.schemas.get(key) as JsonSchemaObject;
    }
    return sorted;
  }

  private claim(
    base: string,
    fragment: JsonSchemaObject,
    authored: boolean
  ): string {
    let candidate = base;
    let suffix = 2;
    for (;;) {
      const existing = this.schemas.get(candidate);
      if (existing === undefined) {
        // A derived name must not squat a reserved authored id.
        if (!authored && this.reserved.has(candidate)) {
          candidate = `${base}_${suffix++}`;
          continue;
        }
        this.schemas.set(candidate, fragment);
        return candidate;
      }
      if (stableEqual(existing, fragment)) return candidate; // identical → dedup
      candidate = `${base}_${suffix++}`; // same name, different content → suffix
    }
  }
}

/** Structural equality for JSON fragments produced by the same converter (stable key order). */
function stableEqual(a: JsonSchemaObject, b: JsonSchemaObject): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
