/**
 * Process-wide count of evaluated `@spinejs/core` copies.
 *
 * Injection tokens rely on Symbol identity (ADR 0007): two evaluated copies of
 * core — a duplicated install in node_modules, or the same install loaded once
 * as ESM and once as CJS — each mint their own token Symbols, and providers
 * registered through one copy resolve to `undefined` through the other. That
 * failure is opaque at the resolution site, so each copy registers itself here
 * at module-evaluation time and `App` warns at boot when more than one is live.
 *
 * The counter lives on `globalThis` under a `Symbol.for` key precisely because
 * `Symbol.for` is shared across copies — the one place where registry-symbol
 * semantics are what we want. Tokens themselves stay `Symbol()`-based.
 */
const CORE_COPIES_KEY = Symbol.for("spinejs.core.copies");

type CoreCopiesHolder = { [CORE_COPIES_KEY]?: number };

const holder = globalThis as CoreCopiesHolder;
holder[CORE_COPIES_KEY] = (holder[CORE_COPIES_KEY] ?? 0) + 1;

/** Number of `@spinejs/core` copies evaluated in this process (1 = healthy). */
export function loadedCoreCopies(): number {
  return holder[CORE_COPIES_KEY] ?? 1;
}
