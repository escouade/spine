import type { Envelope, GatewayContext } from "@spinejs/gateway-core";
import { buildStorageKey, hashKey } from "./key-pipeline";
import { validatePolicy, ThrottleConfigError } from "./policy-validation";
import {
  TOO_MANY_REQUESTS,
  throttleOutcome,
  type KeySelector,
  type LimitReachedEvent,
  type ThrottleErrorEvent,
  type ThrottleOutcome,
  type ThrottlePolicy,
  type ThrottleStore,
} from "./throttle.types";

/** One `configure()` call's fully-resolved, validated configuration — never merged across instances (AD-7). */
export interface ResolvedThrottleConfig {
  /** Instance name (`configure({ name })`), `"default"` when omitted. */
  name: string;
  /** Gateway-default policies, keyed by their configured (unique) name. */
  policies: Record<string, ThrottlePolicy>;
  /** Wired named key sources a string `keyBy` resolves through. */
  keySources: Record<string, KeySelector>;
  /** Observability hook fired on every rejection (FR-14). */
  onLimitReached?: (event: LimitReachedEvent) => void;
  /** Observability hook fired on every policy-evaluation failure — fail-closed telemetry (FR-14). */
  onError?: (event: ThrottleErrorEvent) => void;
  /** Opt-in: include the raw (pre-hash) key on `onLimitReached` events. */
  emitRawKey: boolean;
  /**
   * Outcome observer (AD-8): invoked once per dispatch after the {@link throttleOutcome} ctx slot is
   * written. Reads the slot via `readThrottleOutcome(ctx)` — the `./http` preset plugs its
   * outcome→headers translator here.
   */
  onOutcome?: (ctx: GatewayContext) => void;
}

/** Per-route tuning of a named gateway default (FR-3). Route-inline policies are never overridable. */
export type ThrottlePolicyOverride = Partial<
  Pick<ThrottlePolicy, "limit" | "windowMs" | "keyBy" | "failOpen" | "maxKeys">
>;

/** The `throttle` route option an author writes (typed into route options by the battery's augmentation). */
export interface ThrottleRouteOption {
  /** Route-inline policies, scoped `routeId#index` — non-overridable. */
  policies?: ThrottlePolicy[];
  /** Named gateway defaults disabled for this route. */
  skip?: string[];
  /** Named gateway defaults re-tuned for this route (the merged policy is enforced route-scoped). */
  override?: Record<string, ThrottlePolicyOverride>;
}

/**
 * The namespaced `meta.throttle` contract (AD-3): the user's {@link ThrottleRouteOption} fields
 * copied **verbatim** by the route helpers, plus the one stamped field `routeId` (HTTP:
 * `"METHOD /path"` with the declared path template; IPC: the channel string). `throttle: false`
 * is encoded as `disabled: true`. Only this battery interprets the key — transports copy blindly.
 */
export interface ThrottleRouteMeta extends ThrottleRouteOption {
  routeId: string;
  /** Encodes `throttle: false`: the route opts out of every default policy. */
  disabled?: boolean;
}

/**
 * Fallback route id for targets whose route helper stamped no `meta.throttle.routeId` (a hand-built
 * or as-yet-unstamped target, e.g. IPC channels before Story 2.1). A **route-scoped** policy hitting
 * this is a fail-loud error (never a silent shared `"route"` bucket); a gateway-scoped policy is fine.
 */
const UNSTAMPED_ROUTE_ID = "route";

/** A route's parsed + validated throttle spec, cached per `meta.throttle` object. */
interface ParsedRouteSpec {
  routeId: string;
  /** `true` when no `routeId` was stamped — route-scoped policies must fail loud (AD-3/AD-7). */
  unstamped: boolean;
  disabled: boolean;
  skip: ReadonlySet<string>;
  override: Record<string, ThrottlePolicyOverride>;
  /** Route-inline policies with their synthesized identities. */
  inline: { id: string; policy: ThrottlePolicy }[];
}

const NO_SPEC: ParsedRouteSpec = {
  routeId: UNSTAMPED_ROUTE_ID,
  unstamped: true,
  disabled: false,
  skip: new Set(),
  override: {},
  inline: [],
};

/** One policy's post-`consume` (or synthesized fail-closed) state for this request. */
interface PolicyEvaluation {
  policyName: string;
  limit: number;
  remaining: number;
  resetMs: number;
  accepted: boolean;
  keyHash?: string;
  rawKey?: string;
}

/** An effective (post-`skip`/`override`) policy plus the store-space id its counters live under. */
interface ApplicablePolicy {
  /** Store-space id (`StorePolicy.id`): the policy name, or `name@routeId` for an overridden default. */
  id: string;
  policyName: string;
  policy: ThrottlePolicy;
}

/**
 * The transport-blind policy engine: resolves the applicable policies for a dispatch (gateway
 * defaults minus `skip` plus route-inline, `override` merged), runs the key pipeline
 * (select → normalize → crypto-hash → per-policy scope, AD-5), consumes **every** applicable policy
 * independently (FR-4 — consumption is unconditional, a hit accepted by policy A stays consumed
 * when policy B rejects), writes the {@link throttleOutcome} ctx slot exactly once, and returns the
 * rejection envelope when any policy is exhausted.
 */
export class ThrottleEngine {
  /** Parsed route specs, cached per `meta.throttle` object (stable per route). */
  private readonly specCache = new WeakMap<object, ParsedRouteSpec>();

  constructor(
    private readonly config: ResolvedThrottleConfig,
    private readonly store: ThrottleStore
  ) {}

  /**
   * Evaluates one dispatch. Returns `null` when allowed, or the `TOO_MANY_REQUESTS` failure
   * envelope (carrying `meta.retryAfterMs`) when any applicable policy rejects.
   */
  async evaluate(
    routeMeta: unknown,
    ctx: GatewayContext,
    rawInput: unknown
  ): Promise<Envelope<never, string> | null> {
    const spec = this.parseSpec(routeMeta);
    if (spec.disabled) return null; // `throttle: false` — no policies, no outcome

    const evaluations: PolicyEvaluation[] = [];
    for (const applicable of this.applicablePolicies(spec)) {
      const evaluation = await this.evaluatePolicy(
        applicable,
        spec,
        ctx,
        rawInput
      );
      if (evaluation) evaluations.push(evaluation);
    }
    if (evaluations.length === 0) return null; // nothing applied — no outcome (AD-8)

    // Reported quota = most restrictive (FR-4): smallest remaining, tie-break soonest reset.
    // When rejecting, report among the rejecting policies (they block the retry timing).
    const rejected = evaluations.filter((e) => !e.accepted);
    const reported = mostRestrictive(rejected.length ? rejected : evaluations);
    const outcome: ThrottleOutcome = {
      policyName: reported.policyName,
      limit: reported.limit,
      remaining: reported.remaining,
      resetMs: reported.resetMs,
      // Retry-After must clear EVERY rejecting policy: the LATEST reset over all of them, not the
      // most-restrictive one's — retrying at the soonest reset would still hit a slower policy.
      ...(rejected.length
        ? { retryAfterMs: Math.max(...rejected.map((e) => e.resetMs)) }
        : {}),
    };
    // Written exactly once per dispatch (accept or reject) — AD-8.
    (ctx as { [throttleOutcome]?: ThrottleOutcome })[throttleOutcome] = outcome;
    // Observers are never load-bearing: a throwing outcome/limit hook must not 500 the dispatch.
    try {
      this.config.onOutcome?.(ctx);
    } catch {
      /* observer error swallowed — presentation/metrics must not break enforcement */
    }

    if (rejected.length === 0) return null;

    for (const evaluation of rejected) {
      // Fail-closed synthetic rejections carry no key (the selector/store failed) — the event is
      // about a *reached limit*, so only real exhaustions fire it (fail-closed → `onError` instead).
      if (evaluation.keyHash === undefined) continue;
      try {
        this.config.onLimitReached?.({
          policyName: evaluation.policyName,
          routeId: spec.routeId,
          keyHash: evaluation.keyHash,
          retryAfterMs: evaluation.resetMs,
          ...(this.config.emitRawKey ? { rawKey: evaluation.rawKey } : {}),
        });
      } catch {
        /* observer error swallowed */
      }
    }
    return {
      ok: false,
      code: TOO_MANY_REQUESTS,
      meta: { retryAfterMs: outcome.retryAfterMs },
    };
  }

  /** Gateway defaults (minus `skip`, `override` merged) + route-inline policies with their store ids. */
  private *applicablePolicies(
    spec: ParsedRouteSpec
  ): Iterable<ApplicablePolicy> {
    for (const [name, policy] of Object.entries(this.config.policies)) {
      if (spec.skip.has(name)) continue;
      // Own-property lookup, symmetric with the boot-walk `override` check: a default named like an
      // `Object.prototype` member (e.g. `toString`) would otherwise inherit a truthy value from the
      // prototype chain and be silently treated as overridden — detaching the route from the shared
      // gateway quota (review #40, enforcement half of the same proto-chain class).
      const override = Object.prototype.hasOwnProperty.call(spec.override, name)
        ? spec.override[name]
        : undefined;
      // An overridden default is enforced route-scoped with the merged values, in its OWN store
      // space (`name@routeId`): a per-route `maxKeys` override must not resize — and evict counters
      // in — the shared default's space used by other routes / the gateway scope (AD-5 isolation).
      const effective = override ? { ...policy, ...override } : policy;
      const id = override ? `${name}@${spec.routeId}` : name;
      yield { id, policyName: name, policy: effective };
    }
    for (const inline of spec.inline) {
      yield { id: inline.id, policyName: inline.id, policy: inline.policy };
    }
  }

  /**
   * Runs one policy for this dispatch: key selection (raw pre-validation input), `null`/`undefined`
   * skip, hash + scope, then the store's atomic `consume`. A throwing selector, a non-string
   * selector return, or a throwing store call fires `onError` (fail-closed telemetry) and follows
   * the failure policy: fail-closed (a synthetic no-key rejection) unless the policy sets `failOpen`.
   */
  private async evaluatePolicy(
    applicable: ApplicablePolicy,
    spec: ParsedRouteSpec,
    ctx: GatewayContext,
    rawInput: unknown
  ): Promise<PolicyEvaluation | null> {
    const { id, policyName, policy } = applicable;
    const routeId = spec.routeId;

    // A route-scoped policy on an unstamped target would silently share one `"route"` bucket across
    // every such target — fail loud instead (AD-3/AD-7). Gateway-scoped policies are unaffected.
    if (policy.scope !== "gateway" && spec.unstamped) {
      throw new ThrottleConfigError(
        policyName,
        `a route-scoped policy was applied to a target with no stamped \`routeId\` ` +
          `(a hand-built or as-yet-unstamped target). Stamp \`meta.throttle.routeId\`, or ` +
          `declare the policy \`scope: 'gateway'\``
      );
    }

    const failClosed = (): PolicyEvaluation => ({
      policyName,
      limit: policy.limit,
      remaining: 0,
      resetMs: policy.windowMs,
      accepted: false,
    });

    let rawKey: string | null;
    try {
      const selector =
        typeof policy.keyBy === "function"
          ? policy.keyBy
          : this.config.keySources[policy.keyBy];
      const selected = selector(ctx, rawInput) as unknown;
      // `null`/`undefined` → the selector opted this policy out for this request (FR-6). A non-string
      // is a selector bug: fail loud (routed through the failure policy) rather than hashing garbage.
      if (selected === null || selected === undefined) {
        rawKey = null;
      } else if (typeof selected === "string") {
        rawKey = selected;
      } else {
        throw new TypeError(
          `throttle key selector for policy "${policyName}" returned a ${typeof selected}; ` +
            "a selector must return a string key or null."
        );
      }
    } catch (error) {
      this.reportError(policyName, routeId, "selector", error);
      return policy.failOpen ? null : failClosed();
    }
    if (rawKey === null) return null;

    const scope = policy.scope === "gateway" ? "gateway" : routeId;
    try {
      const result = await this.store.consume(buildStorageKey(scope, rawKey), {
        id,
        limit: policy.limit,
        windowMs: policy.windowMs,
        maxKeys: policy.maxKeys,
      });
      return {
        policyName,
        limit: policy.limit,
        remaining: Math.max(0, policy.limit - result.totalHits),
        resetMs: result.resetMs,
        accepted: result.accepted,
        keyHash: hashKey(rawKey),
        rawKey,
      };
    } catch (error) {
      this.reportError(policyName, scope, "store", error);
      return policy.failOpen ? null : failClosed();
    }
  }

  /** Fires the `onError` telemetry hook, itself guarded so a throwing observer can't mask the failure. */
  private reportError(
    policyName: string,
    routeId: string,
    phase: ThrottleErrorEvent["phase"],
    error: unknown
  ): void {
    try {
      this.config.onError?.({ policyName, routeId, phase, error });
    } catch {
      /* observer error swallowed */
    }
  }

  /**
   * Parses a route's `meta.throttle` into an enforceable spec (cached per meta object). The spec is
   * validated with {@link validateRouteThrottleMeta} first (the same rules as `configure`-level
   * validation), so an invalid inline policy / `skip` / `override` throws {@link ThrottleConfigError}
   * — an interim request-path guard reconciled by the Story 2.2 boot-time walk of transport route
   * snapshots (which now catches the same violations pre-dispatch).
   */
  private parseSpec(routeMeta: unknown): ParsedRouteSpec {
    const raw = readThrottleRouteMeta(routeMeta);
    if (raw === undefined) return NO_SPEC;

    const cached = this.specCache.get(raw);
    if (cached) return cached;

    // Single source of truth for the boot walk and the request path (validated once per meta object).
    // Pass the original route `meta` (with its `.throttle` namespace), not the unwrapped `raw`.
    validateRouteThrottleMeta(
      routeMeta,
      this.config.policies,
      this.config.keySources
    );

    const routeId = raw.routeId ?? UNSTAMPED_ROUTE_ID;
    const inline = (raw.policies ?? []).map((policy, index) => ({
      id: `${routeId}#${index}`,
      policy,
    }));
    const spec: ParsedRouteSpec = {
      routeId,
      unstamped: raw.routeId === undefined,
      disabled: raw.disabled === true,
      skip: new Set(raw.skip ?? []),
      override: raw.override ?? {},
      inline,
    };
    this.specCache.set(raw, spec);
    return spec;
  }
}

/**
 * Validates one route's `meta.throttle` spec against the same rules as `configure`-level validation
 * (NFR-3): `skip`/`override` names must be configured gateway defaults, an `override` may not
 * re-scope a `scope: 'gateway'` default, the merged override values must be valid, and each
 * route-inline policy (identity `routeId#index`) must pass {@link validatePolicy}. Throws
 * {@link ThrottleConfigError} naming the offending policy — never returns anything.
 *
 * Shared by the engine's request-path `parseSpec` and the throttle module's boot-time walk of the
 * transport's readonly route snapshot (Story 2.2), so a bad inline spec (e.g. `'ip'` on IPC) fails
 * boot with the route/channel named rather than the first dispatch. `routeMeta` is a route's opaque
 * `meta` (the `meta.throttle` namespace is read off it); a route with no `meta.throttle` is a no-op.
 */
export function validateRouteThrottleMeta(
  routeMeta: unknown,
  policies: Record<string, ThrottlePolicy>,
  keySources: Record<string, KeySelector>
): void {
  const raw = readThrottleRouteMeta(routeMeta);
  if (raw === undefined) return;
  const routeId = raw.routeId ?? UNSTAMPED_ROUTE_ID;
  const wired = Object.keys(keySources);

  // A hand-built or plain-JS `meta.throttle` (no route helper) can carry malformed sub-fields that
  // would otherwise crash the boot walk / request parse path with a raw native `TypeError` (e.g.
  // `.forEach` on a non-array `policies`, `for…of` over a numeric `skip`). Fail loud with a
  // route-named {@link ThrottleConfigError} first — same style as the config-error messages below.
  assertRouteMetaShape(raw, routeId);

  for (const name of raw.skip ?? []) {
    // Own-property check, not `in`: a builtin like `skip: ["constructor"]`/`"__proto__"` lives on the
    // prototype chain, so `in` would treat it as a configured default and silently no-op the skip
    // (review #40) — `hasOwnProperty` preserves the fail-loud semantics.
    if (!Object.prototype.hasOwnProperty.call(policies, name)) {
      throw new ThrottleConfigError(
        name,
        "`skip` names a policy that is not a configured gateway default — the route would " +
          "enforce a policy the author believes is exempt"
      );
    }
  }
  for (const [name, override] of Object.entries(raw.override ?? {})) {
    // Own-property lookup (see the `skip` note): `policies["__proto__"]` would otherwise resolve to
    // `Object.prototype` (truthy) and pass the "is a configured default" check (review #40).
    const base = Object.prototype.hasOwnProperty.call(policies, name)
      ? policies[name]
      : undefined;
    if (!base) {
      throw new ThrottleConfigError(
        name,
        "`override` names a policy that is not a configured gateway default"
      );
    }
    if (base.scope === "gateway") {
      throw new ThrottleConfigError(
        name,
        "cannot `override` a `scope: 'gateway'` default per-route — an override is enforced " +
          "route-scoped, which would silently detach the route from the shared gateway quota. " +
          "Declare a separate route-inline policy instead"
      );
    }
    // The merged policy is what actually runs — validate IT (an override of `limit: 0` or a
    // `keyBy` typo would otherwise slip past all boot checks and permanently fail closed).
    validatePolicy(
      name,
      { ...base, ...override },
      { routeInline: true, keySources: wired }
    );
  }

  (raw.policies ?? []).forEach((policy, index) => {
    validatePolicy(`${routeId}#${index}`, policy, {
      routeInline: true,
      keySources: wired,
    });
  });
}

/** Reads the namespaced `meta.throttle` off an opaque route meta (the only key the battery reads — AD-3). */
function readThrottleRouteMeta(
  routeMeta: unknown
): ThrottleRouteMeta | undefined {
  if (routeMeta === null || typeof routeMeta !== "object") return undefined;
  const value = (routeMeta as { throttle?: unknown }).throttle;
  // Must be a plain spec object — an array (or any non-object) is never a valid `meta.throttle`.
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as ThrottleRouteMeta;
}

/**
 * Structural guard for a `meta.throttle` spec: the route helpers copy an author's
 * {@link ThrottleRouteOption} verbatim, but a hand-built or plain-JS target can hand us malformed
 * sub-fields the downstream `.forEach` / `for…of` / `Object.entries` would crash on with a native
 * `TypeError`. Rejects each with a route-named {@link ThrottleConfigError} instead; well-formed specs
 * pass untouched. Fields are read as `unknown` (their static types cannot be trusted off an opaque
 * `meta`).
 */
function assertRouteMetaShape(raw: ThrottleRouteMeta, routeId: string): void {
  const meta = raw as {
    routeId?: unknown;
    policies?: unknown;
    skip?: unknown;
    override?: unknown;
    disabled?: unknown;
  };
  const fail = (rule: string): never => {
    throw new ThrottleConfigError(routeId, rule);
  };

  // A non-string (or empty) `routeId` on a hand-built meta is not cosmetic: `parseSpec` treats only
  // `routeId === undefined` as unstamped, so a `null`/`{}`/`""` id slips past the unstamped fail-loud
  // guard and routes every such target into ONE shared `"route"` bucket — a cross-route shared-quota
  // footgun. Reject it here (review #40).
  if (
    meta.routeId !== undefined &&
    (typeof meta.routeId !== "string" || meta.routeId.trim() === "")
  ) {
    fail(
      `\`throttle.routeId\` must be a non-empty string (got ${describeType(
        meta.routeId
      )})`
    );
  }
  if (meta.disabled !== undefined && typeof meta.disabled !== "boolean") {
    fail(
      `\`throttle.disabled\` must be a boolean (got ${describeType(
        meta.disabled
      )})`
    );
  }
  // `policies` must be an array AND every entry a plain object — a `null`/`undefined` entry would
  // otherwise crash `validatePolicy`'s `policy.limit` read with a raw native `TypeError`, the very
  // symptom this guard exists to prevent (review #40; `override` entries are checked likewise below).
  if (meta.policies !== undefined) {
    if (!Array.isArray(meta.policies)) {
      fail(
        `\`throttle.policies\` must be an array of policies (got ${describeType(
          meta.policies
        )})`
      );
    }
    (meta.policies as unknown[]).forEach((policy, index) => {
      if (!isPlainObject(policy)) {
        fail(
          `\`throttle.policies[${index}]\` must be a policy object (got ${describeType(
            policy
          )})`
        );
      }
    });
  }
  if (meta.skip !== undefined) {
    if (!Array.isArray(meta.skip)) {
      fail(
        `\`throttle.skip\` must be an array of policy names (got ${describeType(
          meta.skip
        )})`
      );
    }
    for (const name of meta.skip as unknown[]) {
      if (typeof name !== "string") {
        fail(
          `\`throttle.skip\` must contain only policy-name strings (got ${describeType(
            name
          )})`
        );
      }
    }
  }
  if (meta.override !== undefined) {
    if (!isPlainObject(meta.override)) {
      fail(
        `\`throttle.override\` must be an object mapping policy names to override values ` +
          `(got ${describeType(meta.override)})`
      );
    }
    for (const [name, value] of Object.entries(
      meta.override as Record<string, unknown>
    )) {
      if (!isPlainObject(value)) {
        fail(
          `\`throttle.override.${name}\` must be an object of override values ` +
            `(got ${describeType(value)})`
        );
      }
    }
  }
}

/** A non-null, non-array object — the shape `override` and each of its entries must have. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Human-readable runtime kind for a config-error `(got …)` suffix (`null`/`array` over bare `object`). */
function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Smallest `remaining`, tie-break soonest reset (FR-4's most-restrictive rule). */
function mostRestrictive(evaluations: PolicyEvaluation[]): PolicyEvaluation {
  return evaluations.reduce((best, candidate) =>
    candidate.remaining < best.remaining ||
    (candidate.remaining === best.remaining && candidate.resetMs < best.resetMs)
      ? candidate
      : best
  );
}
