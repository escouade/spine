import type { KeySelector, ThrottlePolicy } from "./throttle.types";

/**
 * Sanity ceiling on `limit` (NFR-3): a sliding log holds up to `limit` timestamps per key, so the
 * ceiling also caps per-key memory by construction.
 */
export const MAX_POLICY_LIMIT = 10_000;

/** Where a policy is declared — route-inline policies obey one extra rule (`scope: 'gateway'` forbidden). */
export interface PolicyValidationContext {
  /** `true` for a policy declared in route options (synthesized identity `routeId#index`). */
  routeInline: boolean;
  /** The wired key-source names a string `keyBy` may resolve to. */
  keySources: ReadonlyArray<string>;
}

/** Boot-time validation error: names the offending policy and the violated rule (NFR-3). */
export class ThrottleConfigError extends Error {
  constructor(policyName: string, rule: string) {
    super(`Invalid throttle policy "${policyName}": ${rule}`);
    this.name = "ThrottleConfigError";
  }
}

/**
 * Validates one policy against the boot rules (NFR-3). Shared by `configure()` (gateway defaults)
 * and the route-inline spec walk — throws {@link ThrottleConfigError}, so misconfiguration explodes
 * at startup with a clear message, never at request time.
 */
export function validatePolicy(
  name: string,
  policy: ThrottlePolicy,
  context: PolicyValidationContext
): void {
  const fail = (rule: string): never => {
    throw new ThrottleConfigError(name, rule);
  };
  // A limit is a slot count — a fractional `limit` (5.5 accepts 5 then rejects) is a config bug.
  if (!Number.isInteger(policy.limit) || policy.limit <= 0) {
    fail(`\`limit\` must be a positive integer (got ${policy.limit})`);
  }
  if (policy.limit > MAX_POLICY_LIMIT) {
    fail(
      `\`limit\` exceeds the sanity ceiling of ${MAX_POLICY_LIMIT} (got ${policy.limit})`
    );
  }
  if (!Number.isFinite(policy.windowMs) || policy.windowMs <= 0) {
    fail(`\`windowMs\` must be a positive number (got ${policy.windowMs})`);
  }
  // A NaN/0/negative `maxKeys` would disable the LRU bound (Math.max(1, NaN) = NaN → no eviction),
  // reopening the per-policy memory-DoS the bound exists to prevent (AD-5). Must be a positive integer.
  if (
    policy.maxKeys !== undefined &&
    (!Number.isInteger(policy.maxKeys) || policy.maxKeys <= 0)
  ) {
    fail(`\`maxKeys\` must be a positive integer (got ${policy.maxKeys})`);
  }
  if (policy.scope === "gateway" && context.routeInline) {
    fail(
      "`scope: 'gateway'` is declarable only in `ThrottleModule.configure`, never route-inline (AD-3)"
    );
  }
  if (
    typeof policy.keyBy === "string" &&
    !context.keySources.includes(policy.keyBy)
  ) {
    const wired = context.keySources.length
      ? context.keySources.map((s) => `'${s}'`).join(", ")
      : "none";
    fail(
      `\`keyBy: '${policy.keyBy}'\` names a key source that is not wired (wired sources: ${wired}). ` +
        "Add it to `configure({ keySources })` or pass a selector function."
    );
  }
}

/**
 * Validates the gateway-default policy record of one `configure()` call. Record keys are unique by
 * construction (an object cannot carry duplicate keys — FR-4's duplicate-name rejection); what CAN
 * collide is a configured name with a route-inline synthesized identity (`routeId#index`), so names
 * containing `#` are rejected to keep the two namespaces disjoint.
 */
export function validatePolicies(
  policies: Record<string, ThrottlePolicy>,
  keySources: Record<string, KeySelector>
): void {
  const wired = Object.keys(keySources);
  for (const [name, policy] of Object.entries(policies)) {
    if (name.includes("#")) {
      throw new ThrottleConfigError(
        name,
        "policy names must not contain `#` (reserved for route-inline synthesized identities `routeId#index`)"
      );
    }
    validatePolicy(name, policy, { routeInline: false, keySources: wired });
  }
}
