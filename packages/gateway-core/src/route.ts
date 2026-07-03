import { defineOwnMeta, readOwnMeta, Injectable } from "@spinejs/core";
import type { CtorDepsMatch, InjectableOptions, Token } from "@spinejs/core";
import type {
  GatewayContext,
  Guard,
  GuardConstructor,
  LoadedRoute,
} from "./gateway.types";
import { UnauthorizedError } from "./ports";
import { isRouteMarker } from "./route-marker";

/** Keys (Symbol.for, stable across module copies) where decorator metadata is stored. */
const CONTROLLER = Symbol.for("app-gateway:controller");
const CONTROLLER_GUARDS = Symbol.for("app-gateway:controller-guards");

/**
 * Marks a class as a gateway controller and, in one decorator, declares it as a provider with its
 * typed constructor deps — folding in `@Injectable`. Routes are declared as instance **fields** via
 * a transport helper (`httpRoutes`/`ipcRoutes`); `getRoutes` scans those fields at registration.
 * No reflect-metadata: the marker + deps are plain own-property symbols on the constructor.
 *
 *   @Controller({ inject: [UsersStore] })
 *   class UsersController {
 *     constructor(private users: UsersStore) {}
 *     list = get("/users", {}, () => this.users.list());
 *   }
 *
 * `inject` is typed exactly like `@Injectable` (a wrong token type/order/arity is a compile error).
 */
export function Controller<const D extends readonly Token[] = []>(
  options: InjectableOptions<D> = {}
) {
  return <C extends new (...args: never[]) => object>(
    cls: C & (D extends readonly [] ? unknown : CtorDepsMatch<C, D>)
  ): C => {
    Injectable(options)(cls as C & CtorDepsMatch<C, D>);
    defineOwnMeta(cls, CONTROLLER, true);
    return cls;
  };
}

/**
 * Attaches guard classes to a controller **class** — they apply to every route on it. Per-route
 * guards are passed in the route helper's options (`guards: [...]`) and merged after these; both
 * are resolved by DI at registration. Class-only (legacy decorator, esbuild-safe, no
 * reflect-metadata): field routes are instance fields, not prototype methods, so there is no
 * method-level decorator target — granularity below the class lives in the helper options.
 */
export function UseGuards(...guards: GuardConstructor[]) {
  return (target: object): void => {
    defineOwnMeta(target, CONTROLLER_GUARDS, guards);
  };
}

/** True when the class carries `@Controller`. */
export function isController(controller: object): boolean {
  return readOwnMeta<boolean>(controller.constructor, CONTROLLER) === true;
}

/**
 * Returns the controller's class-level guard classes (those declared with `@UseGuards` on the class).
 * Per-route guards live on the field markers and are discovered from the instance, not here.
 */
export function getClassGuards(
  controller: new (...args: never[]) => object
): GuardConstructor[] {
  return readOwnMeta<GuardConstructor[]>(controller, CONTROLLER_GUARDS) ?? [];
}

/**
 * Resolves a controller **instance** into transport-ready route descriptors: scans its own
 * enumerable fields for route markers (built by `httpRoutes`/`ipcRoutes`), merges the controller's
 * class-level guards with each route's own `guards`, looks up resolved instances from `guardMap`,
 * and binds each marker's `invoke`. Throws if the class is not a `@Controller`.
 *
 * `Addr` defaults to `unknown` so the feature module can call this without knowing the transport's
 * address type; the concrete transport passes its own `Addr` when calling directly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getRoutes<Ctx extends GatewayContext, Addr = any>(
  controller: object,
  guardMap: Map<GuardConstructor, Guard<GatewayContext>>
): LoadedRoute<Ctx, Addr>[] {
  if (!isController(controller)) {
    throw new Error(`${controller.constructor.name} is not a @Controller.`);
  }
  const ctor = controller.constructor as new (...args: never[]) => object;
  const classGuardClasses = getClassGuards(ctor);

  /** Resolves guard instances from the controller's class-level guards + a route's own guards. */
  const resolveGuards = (routeGuards: GuardConstructor[] = []): Guard<Ctx>[] =>
    [...classGuardClasses, ...routeGuards].map((cls) => {
      const instance = guardMap.get(cls);
      if (!instance)
        throw new Error(
          `Guard ${cls.name} is not in the guard map — add it to DI inject.`
        );
      return instance as Guard<Ctx>;
    });

  const routes: LoadedRoute<Ctx, Addr>[] = [];
  for (const key of Object.keys(controller)) {
    const value = (controller as Record<string, unknown>)[key];
    if (!isRouteMarker(value)) continue;
    routes.push({
      address: value.address as Addr,
      guards: resolveGuards(value.guards),
      input: value.input,
      invoke: (ctx: Ctx, input: unknown) => value.invoke(ctx, input),
      meta: value.meta,
    });
  }
  return routes;
}

/**
 * Every guard class a controller instance references: class-level (`@UseGuards`) plus the per-route
 * `guards` carried on its field markers. Used by the feature module to resolve guard instances from
 * its own container before calling `getRoutes`.
 */
export function getReferencedGuards(controller: object): GuardConstructor[] {
  const ctor = controller.constructor as new (...args: never[]) => object;
  const seen = new Set<GuardConstructor>(getClassGuards(ctor));
  for (const key of Object.keys(controller)) {
    const value = (controller as Record<string, unknown>)[key];
    if (!isRouteMarker(value)) continue;
    for (const g of value.guards ?? []) seen.add(g);
  }
  return [...seen];
}

// Re-export for convenience so callers importing from './route' get UnauthorizedError too.
export { UnauthorizedError };
