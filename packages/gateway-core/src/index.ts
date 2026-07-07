// app-gateway public API: composable gateway helpers (dispatch pipeline + DI loading + ports).
// NOT a base class to extend — transports compose `DispatchPipeline` and own their bind/register.
// Dep-free besides app-core; concrete transports (IPC/HTTP/…) and validators live downstream.
export type {
  DispatchTarget,
  Envelope,
  FailureMeta,
  GatewayContext,
  Guard,
  GuardConstructor,
  JsonSchemaObject,
  JsonValue,
  LoadedRoute,
  ParseableSchema,
} from "./gateway.types";
export { Controller, UseGuards, getRoutes, isController } from "./route";
export { ROUTE_MARKER, isRouteMarker, makeRouteMarker } from "./route-marker";
export type { RouteMarker } from "./route-marker";
export { DispatchPipeline } from "./pipeline";
export { ValidationError, UnauthorizedError } from "./ports";
export type {
  ChainInterceptor,
  ConnectInterceptor,
  ContextFactory,
  ErrorMapper,
  GatewayInterceptor,
  MetaValidator,
  SchemaConverter,
  Validator,
} from "./ports";
export { validateRouteMeta } from "./meta-validator";
export {
  gatewayFeatureFactory,
  gatewayModuleDecorator,
} from "./feature-module";
export type { FeatureModuleConfig } from "./feature-module";
export { toProvider } from "./provider-adapter";
export type { ProviderAdapter } from "./provider-adapter";
