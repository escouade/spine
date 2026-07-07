# ADR 0023 — `MetaValidator`: a boot-time, per-route validation primitive owned by the gateway

- **Status**: Accepted
- **Date**: 2026-07-07
- **Scope**: `packages/gateway-core` (`ports.ts` — new `MetaValidator` port; `meta-validator.ts` — the
  pure `validateRouteMeta` walk), `packages/http-gateway` + `packages/electron-ipc-gateway`
  (a `metaValidators` configure slot + a boot walk in the module's `onStart`), `packages/throttle`
  (ships `ThrottleMetaValidator`, removes the `configure({ routes })` boot-walk and its route-snapshot
  plumbing; hardens `validateRouteThrottleMeta`).
- **Relation**: retires the interim throttle boot-walk (`ThrottleModule.configure({ routes })`,
  Story 2.2) in favor of a first-class framework primitive. Sits alongside — and is deliberately
  **separate** from — the interceptor port ([ADR 0002](0002-gateway-transport-agnostic.md)) and its
  connect-phase marker [ADR 0022](0022-connect-interceptor-capability-marker.md). Closes review
  findings F-B/F-C from the post-merge review of throttle PR #38.
- **Reference**: `_bmad-output/planning-artifacts/story-metavalidator.md` (+ its "Realignment
  2026-07-07" section) and `_bmad-output/planning-artifacts/metavalidator-impl-brief.md`.

## Context

A battery like `@spinejs/throttle` stamps its own namespaced slice onto each route's opaque `meta`
(`meta.throttle`) and wants to validate every such slice **at boot** — a typo in a route-inline policy
should fail startup, not the first dispatch (NFR-3). The interim mechanism (throttle Story 2.2) made
the app hand-wire a route snapshot into the battery: `configure({ routes: () => gateway.routes })`. The
battery module then walked that snapshot in its own `onStart`.

That wiring is where the information lives in the wrong place, and the post-merge review found three
real gaps rooted in exactly that:

- **F-B** — the snapshot can be wired to the **wrong** gateway: the walk then validates routes that are
  never enforced and skips the enforced ones. Boot is green; the real routes are unchecked.
- **F-C** — a shared snapshot across two battery instances makes one instance's walk raise false
  `skip`/`override` failures against **another** instance's policies.
- (**F-A**, the SSE-connect-enforcement half, was closed independently by [ADR 0022](0022-connect-interceptor-capability-marker.md):
  a throttle interceptor in `interceptors` now enforces at connect automatically. What remained for
  this story is the **shape-validation-on-the-right-gateway** half.)

Root cause: the app plumbs information the gateway already holds — its own routes **and** its own
registered validators. The gateway should cross them itself.

## Decision

Introduce a `MetaValidator` primitive in `gateway-core` and let each gateway own **both halves** of the
crossing (its routes × its validators), at boot.

### 1. The port — `MetaValidator`, separate from `GatewayInterceptor`

```ts
export interface MetaValidator {
  readonly namespace: string; // the meta key it owns, e.g. "throttle"
  validate(routeId: string, meta: unknown): void; // throws a typed config error on invalid
}
```

Kept a **distinct concept** from `GatewayInterceptor`/`ConnectInterceptor` (Fab's explicit
requirement): those are **runtime**, per-request/per-connect wrappers around `dispatch`; a
`MetaValidator` is **boot-time**, per-route, and never runs on the dispatch path. Different type,
different configure slot, different lifecycle — do not conflate them. The two are not rivals: a battery
ships both and the app places the interceptor in `interceptors` and the validator in `metaValidators`
of the **same** gateway.

### 2. The walk — a pure helper, one implementation for every transport

```ts
export function validateRouteMeta<Addr>(
  routes: readonly { address: Addr; meta?: unknown }[],
  validators: readonly MetaValidator[],
  addressToRouteId: (address: Addr) => string
): void;
```

Zero validators → no walk at all (backward-compatible, zero overhead). For each route whose `meta`
carries a validator's `namespace`, it hands that validator the unwrapped slice and lets it throw. Each
transport calls it with its own `address → routeId` fn, so the crossing lives **once**, not per
transport.

### 3. The slot + walk on each gateway module

Both `HttpGatewayModule.configure` and `ElectronIpcGatewayModule.configure` gain a
`metaValidators?: ProviderAdapter<MetaValidator[]>` option (default `[]`), mirroring `interceptors`.
Each module's `onStart` runs the walk over **its own** `gateway.routes`:

- HTTP: `addressToRouteId` maps `{ method, path }` to the routeId the helpers stamp (`"GET /path"`); the
  walk runs **before** `listen()`, so a bad route fails boot before the port opens.
- IPC: `addressToRouteId` is identity — the channel string IS the routeId. The IPC module had **no**
  lifecycle before; it gains an `onStart` whose whole job is this walk (there is no `listen`).

Because a validator runs on the gateway whose slot holds it, **validated routes == enforced routes by
construction** — F-B and F-C are structurally impossible: a validator can only ever see its own
gateway's routes and its own instance's policies.

### 4. `throttle` adopts it; the `configure({ routes })` walk is removed

`@spinejs/throttle` ships `ThrottleMetaValidator` (namespace `"throttle"`) wrapping the existing
`validateRouteThrottleMeta` logic, exposed as `throttleMetaValidatorRef(name)` (memoized per instance
name, the `throttleInterceptorRef` precedent). Removed: the `routes` configure option, the
`RouteSnapshot`/`RouteSnapshotSource` types, the `routesSourceToken`, and the module's `onStart`
route-walk (the module keeps `OnInit`/`OnStop` for the name claim + store dispose). Migration is
documented (EN + FR).

### 5. Two `validateRouteThrottleMeta` fail-silent findings hardened (AC8)

Since this story owns the throttle validator, it absorbs the two remaining #40-review findings that
would otherwise fail **silently**:

- **exotic `override` value** — an `override` entry that is `typeof === "object"` but not a genuinely
  plain object (`Date`/`Map`/`RegExp`) passed the loose object check, then spread to nothing
  (`{ ...base, ...value }`) and silently **dropped** the override. Now rejected via a proto-based
  `isGenuinelyPlainObject` (accepts `{}` and `Object.create(null)`, rejects exotic instances), naming
  the route + entry at boot.
- **malformed `keyBy`** — a `keyBy` that is neither a string nor a function slipped past every boot
  check and failed **closed silently** at the first dispatch (the engine can neither look it up nor
  call it). Now rejected during `validatePolicy`, naming the policy at boot.

## Alternatives considered

- **Keep `configure({ routes })` (the interim)** — app-plumbed snapshot; wired to the wrong gateway it
  validates never-enforced routes (F-B), and shared across instances it raises false cross-instance
  failures (F-C). This ADR retires it.
- **Reuse the `interceptors` slot / port for validation** — conflates a boot-time per-route concern
  with a runtime per-request one; an interceptor would have to carry a "validate" method it never runs
  on dispatch. Rejected (Fab's explicit requirement to keep them separate).
- **A global `register()` side-effect** — a battery registering itself into a process-wide registry —
  is not DI-native, not testable in isolation, and re-opens the wrong-gateway ambiguity. Rejected in
  favor of a per-gateway slot the gateway owns.

## Consequences

- **Positive**: F-B and F-C are structurally impossible — the gateway crosses its own routes × its own
  validators, so validated == enforced by construction; no app plumbing, no shared snapshot.
- **Positive**: the primitive is generic. Any battery can ship a `MetaValidator` for its namespace and
  drop it into `metaValidators`; the crossing logic is written once in `gateway-core`.
- **Positive**: additive and backward-compatible — zero validators wired → no walk; existing configs
  compile and behave unchanged.
- **Positive**: the IPC gateway now fails boot on a bad route-inline spec too (it previously had no
  lifecycle to walk in).
- **Negative / breaking (throttle only, 0.x)**: `ThrottleModule.configure({ routes })` and the
  `RouteSnapshot`/`RouteSnapshotSource` exports are removed. The replacement is a two-line change
  (place `throttleMetaValidatorRef()` in the gateway's `metaValidators`); documented EN + FR.
- **Non-scope (separate follow-up)**: the connect-safety boot-assert flagged as residual in
  [ADR 0022](0022-connect-interceptor-capability-marker.md) — flagging a request-scoped interceptor
  that wrongly exposes `interceptConnect` — is a check over the gateway's **interceptors**, not its
  routes, and needs a `requestScoped` marker on `MikroOrmInterceptor` (a different package). It is NOT
  this story. `MetaValidator` validates route `meta` only.
