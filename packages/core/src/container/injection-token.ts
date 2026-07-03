export class InjectionToken<T = unknown> {
  declare readonly _type: T;
  /**
   * Resolution key = a UNIQUE symbol per token instance (`Symbol()`, NOT `Symbol.for`).
   * Tokens therefore match by IDENTITY, not by description: define a token ONCE, export it, and
   * import it everywhere it is provided/injected.
   *
   * Why not `Symbol.for(description)`? Its global registry makes two unrelated tokens that happen to
   * share a description collide SILENTLY — a classic footgun. `Symbol()` makes a forgotten/duplicated
   * token fail loudly (`Unknown provider`) instead.
   * `Symbol.for` only pays off for a library loaded as several copies (multi-bundle) —
   * which app-core, a single Electron main bundle, never is.
   *
   * `description` is kept for debugging / `toString` only; it plays no part in resolution.
   */
  readonly key: symbol;

  constructor(public readonly description: string) {
    this.key = Symbol(description);
  }

  toString() {
    return `InjectionToken(${this.description})`;
  }
}
