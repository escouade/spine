// @spinejs/throttle public API — the transport-blind core (AD-1): policy types, ports
// (ThrottleStore, Clock, KeySource), the outcome ctx symbol, the module and the interceptor.
// Transport knowledge lives only in the subpaths: `./http`, `./electron-ipc`; the store contract
// kit ships under `./testing`.
export type {
  Clock,
  ConsumeResult,
  KeySelector,
  LimitReachedEvent,
  StorePolicy,
  ThrottleErrorEvent,
  ThrottleOutcome,
  ThrottlePolicy,
  ThrottleStore,
  ThrottleStoreStats,
} from "./throttle.types";
export {
  readThrottleOutcome,
  throttleOutcome,
  TOO_MANY_REQUESTS,
} from "./throttle.types";
export { MAX_POLICY_LIMIT, ThrottleConfigError } from "./policy-validation";
export { InMemoryThrottleStore, monotonicClock } from "./memory-store";
export type { InMemoryThrottleStoreOptions } from "./memory-store";
export { buildStorageKey, hashKey } from "./key-pipeline";
export { ThrottleEngine, validateRouteThrottleMeta } from "./engine";
export type {
  ResolvedThrottleConfig,
  ThrottlePolicyOverride,
  ThrottleRouteMeta,
  ThrottleRouteOption,
} from "./engine";
export { ThrottleInterceptor } from "./interceptor";
export { ThrottleMetaValidator } from "./meta-validator";
export {
  ThrottleModule,
  throttleInterceptorRef,
  throttleMetaValidatorRef,
} from "./throttle.module";
export type { ThrottleModuleOptions } from "./throttle.module";
