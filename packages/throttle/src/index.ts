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
export { ThrottleInterceptor } from "./interceptor";
export type { ResolvedThrottleConfig } from "./interceptor";
export { ThrottleModule, throttleInterceptorRef } from "./throttle.module";
export type { ThrottleModuleOptions } from "./throttle.module";
