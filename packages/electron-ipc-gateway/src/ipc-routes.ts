import { makeRouteMarker } from "@spinejs/gateway-core";
import type {
  GuardConstructor,
  ParseableSchema,
  RouteMarker,
} from "@spinejs/gateway-core";
import type { ElectronIpcBaseContext } from "./electron-ipc-base.types";

/**
 * Per-route options for an IPC field route. Unlike HTTP (split `params`/`query`/`body`), an IPC call
 * carries a single payload, so there is one `input` schema. `response` is reserved for future schema
 * export — carried in the marker's `meta`, never validated. `guards` are per-route guard classes
 * (merged after the controller's class-level `@UseGuards`).
 *
 * The interface is intentionally open: a battery may add a documented, namespaced option through a
 * `declare module "@spinejs/electron-ipc-gateway"` augmentation (e.g. `throttle`, shipped by
 * `@spinejs/throttle/electron-ipc`). The transport copies such fields verbatim onto the marker's
 * `meta` (see {@link IpcRouteMeta}) and never interprets them — full parity with the HTTP verb
 * helpers (AD-3).
 */
export interface IpcRouteSchemas<I> {
  input?: ParseableSchema<I>;
  response?: ParseableSchema<unknown>;
  guards?: GuardConstructor[];
}

/**
 * Opaque per-transport extras carried on an IPC marker's `meta` (never interpreted by the core): the
 * single `input` schema plus the `response` schema (reserved for future schema export). A battery may
 * own a documented, namespaced key here via augmentation (e.g. `throttle`) — the transport copies it
 * blindly, only that battery's interceptor reads it.
 */
export interface IpcRouteMeta {
  input?: ParseableSchema<unknown>;
  response?: ParseableSchema<unknown>;
}

/**
 * The validated payload handed to the callback: the `input` schema's inferred output when present,
 * else `undefined` (a channel with no payload). Driven by the *actual* schemas object type `S`
 * inferred at the call site, so a missing `input` collapses to `undefined`.
 */
export type IpcInputOf<S> = S extends { input: ParseableSchema<infer V> }
  ? V
  : undefined;

/**
 * App-wide context registry — augmented ONCE per app (like `Express.Request`) to declare the
 * `ContextFactory`'s output type as the default `ctx` of every route:
 *
 *   declare module "@spinejs/electron-ipc-gateway" {
 *     interface IpcContextRegistry { context: AppContext }
 *   }
 *
 * Without this augmentation `DefaultCtx` falls back to `ElectronIpcBaseContext`, so `ctx.user` (any
 * app-specific field) does NOT exist. The augmentation is mandatory to type app concerns on `ctx`.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface IpcContextRegistry {}

/**
 * The default `ctx` type of a route: the registry's `context` when augmented, else
 * `ElectronIpcBaseContext`. A route overrides it per-call by annotating the callback's `ctx` param.
 */
export type DefaultCtx = IpcContextRegistry extends {
  context: infer C extends ElectronIpcBaseContext;
}
  ? C
  : ElectronIpcBaseContext;

/**
 * A typed IPC route helper: `(channel, schemas, fn) => RouteMarker`. The callback takes the
 * validated `input` first (inferred from `schemas.input`) and `ctx` last — so a route that ignores
 * both just writes `() => ...`, one that needs the payload writes `(input) => ...`, and one that
 * needs the context writes `(input, ctx) => ...`, all with `ctx` fully typed and no annotation.
 */
export type IpcRouteHelper<Ctx extends ElectronIpcBaseContext> = <
  S extends IpcRouteSchemas<unknown>,
  Out
>(
  channel: string,
  schemas: S,
  fn: (input: IpcInputOf<S>, ctx: Ctx) => Out
) => RouteMarker<Ctx, string>;

/** The helpers returned by `ipcRoutes`. IPC has a single verb, so just `handle`. */
export interface IpcRouteHelpers<Ctx extends ElectronIpcBaseContext> {
  handle: IpcRouteHelper<Ctx>;
}

/** True for a non-null, non-array object literal (the only shape a battery `meta` namespace accepts). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Shared runtime builder: assembles the IPC marker from `channel` + schemas + callback. */
function buildMarker<
  Ctx extends ElectronIpcBaseContext,
  S extends IpcRouteSchemas<unknown>,
  Out
>(
  channel: string,
  schemas: S,
  fn: (input: IpcInputOf<S>, ctx: Ctx) => Out
): RouteMarker<Ctx, string> {
  const meta: IpcRouteMeta = {
    input: schemas.input,
    response: schemas.response,
  };
  // Namespaced battery meta (AD-3) — full parity with the HTTP verb helpers: the user's `throttle`
  // option fields are copied VERBATIM under `meta.throttle` with exactly one stamped field added —
  // `routeId` = the channel string. The transport never interprets the fields (opaque copy);
  // `throttle: false` is encoded as `disabled: true`. The option itself is typed only by
  // `@spinejs/throttle`'s `declare module` augmentation — without the battery, `throttle:` is an
  // unknown property. Guard the plain-JS misuse the augmentation can't (`throttle: true` / a string
  // would spread to nothing and silently run with defaults): only an options object or `false` is valid.
  const throttleOption = (schemas as { throttle?: unknown }).throttle;
  if (
    throttleOption !== undefined &&
    throttleOption !== false &&
    !isPlainObject(throttleOption)
  ) {
    throw new Error(
      `IPC channel "${channel}": \`throttle\` must be a throttle options object or \`false\` ` +
        `(got ${
          Array.isArray(throttleOption) ? "an array" : typeof throttleOption
        }).`
    );
  }
  (meta as { throttle?: unknown }).throttle = {
    ...(throttleOption === false ? { disabled: true } : throttleOption),
    routeId: channel,
  };
  return makeRouteMarker<Ctx, string, IpcInputOf<S>>({
    address: channel,
    input: schemas.input,
    fn,
    guards: schemas.guards,
    meta,
  });
}

/**
 * A module-level IPC route function. `Ctx` defaults to `DefaultCtx` (the registry) when the
 * callback's `ctx` is left unannotated, and is inferred from the annotation when a route overrides
 * it (`(input, ctx: Other) =>`). `input` is inferred from `schemas.input`.
 */
export type HandleFn = <
  S extends IpcRouteSchemas<unknown>,
  Out,
  Ctx extends ElectronIpcBaseContext = DefaultCtx
>(
  channel: string,
  schemas: S,
  fn: (input: IpcInputOf<S>, ctx: Ctx) => Out
) => RouteMarker<Ctx, string>;

/**
 * Framework-level IPC route helper — the recommended API. Import it straight from
 * `@spinejs/electron-ipc-gateway`; no per-app factory file. The `ctx` of each callback defaults to
 * `DefaultCtx` (your app context, declared once via the `IpcContextRegistry` augmentation) and can
 * be overridden per route by annotating the callback's `ctx` param. `input` is inferred from
 * `schemas.input`. Declare routes as controller instance fields:
 *
 *   import { handle } from "@spinejs/electron-ipc-gateway";
 *
 *   class WhoAmIController {
 *     whoami = handle("whoami", {}, () => ...);
 *     greet  = handle("greet", { input: greetSchema }, ({ name }, ctx) => ...);
 *   }
 *
 * Each helper builds a `RouteMarker` the gateway's `getRoutes` picks off the instance fields.
 */
export const handle: HandleFn = <
  S extends IpcRouteSchemas<unknown>,
  Out,
  Ctx extends ElectronIpcBaseContext = DefaultCtx
>(
  channel: string,
  schemas: S,
  fn: (input: IpcInputOf<S>, ctx: Ctx) => Out
): RouteMarker<Ctx, string> => buildMarker(channel, schemas, fn);

/** Builds the `handle` helper bound to the chosen context type `Ctx`. */
function makeHandle<Ctx extends ElectronIpcBaseContext>(): IpcRouteHelper<Ctx> {
  return <S extends IpcRouteSchemas<unknown>, Out>(
    channel: string,
    schemas: S,
    fn: (input: IpcInputOf<S>, ctx: Ctx) => Out
  ): RouteMarker<Ctx, string> => buildMarker(channel, schemas, fn);
}

/**
 * @deprecated Prefer the module-level `handle` from `@spinejs/electron-ipc-gateway` plus a one-time
 * `IpcContextRegistry` augmentation for the default `ctx`. This factory (which binds a context type
 * per app file) is kept only for a soft transition and will be removed.
 *
 * Field-wrapper route API for the IPC transport. Returns a `handle` helper bound to a context type,
 * so the callback's `input` is INFERRED from `schemas.input` and `ctx` (last arg) is typed WITHOUT
 * annotation; omit `ctx` (and `input`) when unused. Declare routes as controller instance fields:
 *
 *   const { handle } = ipcRoutes<AppContext>();
 */
export function ipcRoutes<
  Ctx extends ElectronIpcBaseContext = ElectronIpcBaseContext
>(): IpcRouteHelpers<Ctx> {
  return { handle: makeHandle<Ctx>() };
}
