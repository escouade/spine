import { InjectionToken } from "./injection-token";
import { ProviderConstructor, ProviderScope, Token } from "./container.types";
import { defineOwnMeta, readOwnMeta } from "../utils";

/**
 * Key (Symbol.for, stable across module copies) where the tokens to inject into
 * the constructor are stored. The `Container` reads it when a class provider
 * has no explicit `inject:`. Written by `@Injectable({ inject: [...] })` at class
 * level — **typed** (ResolvedTuple): a token of the wrong type/order = compile error.
 * Modules declare their deps via `@Module({ inject: [...] })` instead.
 */
const INJECT_DEPS = Symbol.for("app-core:inject-deps");

/**
 * Key where a class provider's scope is stored. Written by `@Injectable({ scope })`,
 * read by the `Container` when no `scope` is set on the provider object. Absent ⇒ singleton.
 */
const SCOPE = Symbol.for("app-core:scope");

// Type of a resolved token: InjectionToken<T> or class Ctor<T> yields T.
type Resolved<X> = X extends InjectionToken<infer U>
  ? U
  : X extends ProviderConstructor<infer U>
  ? U
  : never;

/** Tuple of tokens → tuple of the types they resolve, in order. */
export type ResolvedTuple<D extends readonly Token[]> = {
  [K in keyof D]: Resolved<D[K]>;
};

/**
 * Asserts the constructor params are assignable **to** the resolved tokens, i.e.
 * each param is at least as specific as its token's type. Resolves to `unknown`
 * (the intersection is a no-op) on a match, `never` (param becomes unusable →
 * compile error) on a mismatch of order/type/arity. The direction matters: a
 * class token to a generic class resolves to `T<unknown>` (widening), so a
 * constructor declaring a precise `T<Concrete>` must be accepted — hence we check
 * `params ⊆ resolved`, not the reverse.
 */
export type CtorDepsMatch<
  C extends new (...args: never[]) => unknown,
  D extends readonly Token[]
> = ConstructorParameters<C> extends ResolvedTuple<D> ? unknown : never;

/** Options for `@Injectable`: typed constructor deps and an optional lifecycle scope. */
export interface InjectableOptions<
  D extends readonly Token[] = readonly Token[]
> {
  inject?: D;
  scope?: ProviderScope;
}

// **own-property only** read: otherwise a subclass would inherit the parent's deps.
function ownDeps(cls: object): Token[] | undefined {
  return readOwnMeta<Token[]>(cls, INJECT_DEPS);
}

/**
 * Declares a class as a provider: its dependencies **explicitly and typed** (no
 * reflect-metadata) plus an optional lifecycle `scope` (defaults to singleton).
 *
 * The constraint forces each constructor param to be assignable to its token's
 * resolved type (`CtorDepsMatch`): a token of the wrong type/order/arity = compile
 * error, while a constructor may declare a more specific type than a (necessarily
 * widened) generic-class token.
 *
 * Works the same in legacy as in stage-3: a plain function that sets metadata on
 * the class. esbuild drops the legacy metadata → no runtime polyfill.
 *
 *   @Injectable({ inject: [Dep], scope: "transient" })
 *   class Foo {}
 */
export function Injectable<const D extends readonly Token[] = []>(
  options: InjectableOptions<D> = {}
) {
  return <C extends new (...args: never[]) => unknown>(
    cls: C & CtorDepsMatch<C, D>
  ): C => {
    if (options.inject) defineOwnMeta(cls, INJECT_DEPS, [...options.inject]);
    if (options.scope) defineOwnMeta(cls, SCOPE, options.scope);
    return cls;
  };
}

/** Reads the deps set by `@Injectable`/`@Module` on a class; `undefined` otherwise. */
export function getInjectedDeps(token: unknown): readonly Token[] | undefined {
  return typeof token === "function" ? ownDeps(token) : undefined;
}

/** Reads the scope set by `@Injectable` on a class; `undefined` otherwise. */
export function getProviderScope(token: unknown): ProviderScope | undefined {
  return typeof token === "function"
    ? readOwnMeta<ProviderScope>(token, SCOPE)
    : undefined;
}
