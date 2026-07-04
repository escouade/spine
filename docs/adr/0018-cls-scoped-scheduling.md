# ADR 0018 — CLS-scoped scheduling (`@spinejs/scheduler`)

- **Status**: Accepted
- **Date**: 2026-07-04
- **Scope**: new package `packages/scheduler` (`scheduler.module.ts`, `scheduler.registry.ts`,
  `scheduler.options.ts`). Depends only on `@spinejs/core` + `@spinejs/cls`; **no** ORM dependency.
- **Relation**: makes a scheduled tick a _synthetic request_ by reusing the CLS scope of
  [ADR 0003](0003-cls-request-context.md); follows the two-phase module lifecycle of
  [ADR 0009](0009-module-loading-two-phases.md)/[ADR 0010](0010-atomic-module-lifecycle.md) and drains
  under the shutdown budget of [ADR 0013](0013-shutdown-timeout-hard-kill.md); uses the explicit typed
  DI of [ADR 0007](0007-injection-token-symbol-identity.md)/[ADR 0008](0008-explicit-injection-no-reflect-metadata.md).
  Second of two "server batteries" built cold per studio ADR 0017 §3 (the first is
  [ADR 0017](0017-sse-fan-out-in-http-gateway.md); ORM is spine ADR 0016). Composes with the
  `@spinejs/mikro-orm` battery via an `around` hook.

## Context

A server backend needs **periodic background work**. The concrete drivers are studio ADR 0017 §2: an
**outbox projector** (poll a feed every couple of seconds, create jobs) and a **lease sweep** (requeue
expired leases). Both are plain fixed-interval pollers.

The interesting part is not the timer — `setInterval` is trivial — it is **what a tick runs inside**. An
HTTP request in spine gets a fresh CLS scope (`ClsInterceptor`, ADR 0003) and, with the ORM battery, a
forked `EntityManager` stashed in that scope (a per-request UnitOfWork). A service deep in the graph then
reads and writes through the request-scoped EM with **no manager threading and no explicit `.save()`**.
A background poll that wants the same ergonomics — and the projector/sweep do: they mutate entities
exactly like a handler — has, on NestJS, no natural path to it (`@nestjs/schedule`'s `@Cron`/`@Interval`
give a `SchedulerRegistry` but no per-tick request scope; `Scope.REQUEST` doesn't apply to a timer). You
wire the UoW by hand.

So the question this ADR answers is: **can a scheduled tick be a synthetic request** — a fresh CLS scope
per tick, so a task's services resolve request-scoped state (a per-tick UnitOfWork) byte-for-byte like an
HTTP handler? If yes, that symmetry is the entire reason to build scheduling _in spine_ rather than lean
on `@nestjs/schedule`. If the ORM battery weren't underneath it, this advantage would evaporate and the
mature, cron-complete `@nestjs/schedule` would win. The mechanism was spiked runnable, 4/4 green, before
committing (see `docs/plans/spine-batteries.spike.mjs`).

## Decision

Ship a standalone, transport-agnostic `@spinejs/scheduler`. Each tick runs inside its own
`cls.run(seed, …)` scope; an `around` hook composes a per-tick UnitOfWork (or tracing, metrics) inside
that scope; overlap defaults to **skip**; the module drains in-flight ticks on `onStop`.

### 1. A tick is a synthetic request

`SchedulerRegistry.runOnce` opens a fresh CLS scope per tick and runs the composed work inside it:

```ts
private async runOnce(s: TaskState): Promise<void> {
  s.running = true;
  try {
    // Each tick is its own CLS scope: a synthetic request. `around` hooks (e.g. a UnitOfWork)
    // run inside it, so services resolve request-scoped state with no manager threading.
    // `seed()` is inside the try so a throwing seed is caught/logged (not left wedging `running`).
    const seed: ClsStore = s.task.seed?.() ?? {};
    await this.cls.run(seed, s.boundRun);
  } catch (e) {
    this.log.error(`scheduler task "${s.task.name}" failed`, e);
  } finally {
    s.running = false;
  }
}
```

Because `cls.set()` inside an `around` hook runs _inside_ this `cls.run`, a `mikroOrmUnitOfWork` hook
does per tick exactly what `MikroOrmInterceptor` does per request: `em = orm.em.fork(); cls.set(EM, em);
begin() … commit()/rollback()`. Same UoW, same identity map, same "no `.save()`". The projector's data
access is identical to an HTTP handler's.

### 2. `around` hooks, not a `TickInterceptor` taxonomy

The UoW composition is a plain function wrapper, applied inside the CLS scope, outermost-first:

```ts
export type TickAround = (next: () => Promise<void>) => () => Promise<void>;

const compose = (arounds: readonly TickAround[], run: () => Promise<void>) =>
  arounds.reduceRight<() => Promise<void>>((next, around) => around(next), run);
```

`mikroOrmUnitOfWork` ships with the **separate** `@spinejs/mikro-orm` battery — the scheduler has **no**
ORM dependency; any `around` (tracing, metrics, a custom UoW) composes the same way. There is
deliberately **no** first-class `TickInterceptor` type mirroring `GatewayInterceptor`: by the Rule of
Three, exactly one cross-cutting wrapper (the UoW) exists today. A taxonomy is promoted only when a third
concern appears.

### 3. Explicit `configure({ tasks, imports })` registration

Registration is explicit and DI-typed — no field-form scan, matching the ORM battery's style. A task
declares its interval, its `inject` tokens, and its work; the modules that **export** those tokens come
in via `imports`:

```ts
SchedulerModule.configure({
  imports: [JobsModule], // exports Projector, Leases
  tasks: [
    {
      name: "outbox-projector",
      everyMs: 2_000,
      inject: [Projector],
      run: (p: Projector) => p.pollAndCreateJobs(),
      around: [mikroOrmUnitOfWork],
    },
    {
      name: "lease-sweep",
      everyMs: 5_000,
      inject: [Leases],
      run: (l: Leases) => l.requeueExpired(),
      around: [mikroOrmUnitOfWork],
    },
  ],
});
```

DI wiring stays pure explicit-inject with **no container introspection**: `configure` builds one
`FactoryProvider<SchedulerRegistry>` whose `inject` is `[ClsService, loggerToken, ...flatTokens]` — every
task's `inject` tokens flattened into one list. The factory then slices the resolved instances back per
task (`deps.slice(offset, offset + count)`) and calls `registry.register(task, deps)`. `imports` is
merged with `ClsModule`.

### 4. Overlap = skip (default), queue opt-in and bounded

`runNow` (the timer callback, also callable directly) honors the overlap policy:

- **`skip` (default)**: if a tick is still running, drop this one. A poll loop must never stack on a slow
  previous poll.
- **`queue`**: serialize — chain after the in-flight tick. The pending chain depth is **bounded**
  (`maxQueued`, default `1000`); past the cap a tick is dropped with a warning, so a task slower than its
  interval cannot grow an unbounded backlog.

A failing tick is caught and logged (`runNow` never rejects) — **one bad tick never crashes the app or
kills the timer**.

### 5. Lifecycle: arm on start, drain on stop

`SchedulerModule implements OnStart/OnStop` (ADR 0010). `onStart` → `registry.start()` arms one
`setInterval` per task, each `unref()`ed so a scheduler timer never on its own keeps the process alive.
`onStop` → `registry.stop()` clears every timer (no new ticks) then `await Promise.allSettled(inflight)`
— a running projector finishes its batch. The app's `shutdownTimeout` hard-kill (5 s, ADR 0013) is the
ultimate backstop, so a wedged tick can't hang shutdown.

### 6. Multi-replica is deliberately not solved

`setInterval` runs **per instance**. In multi-replica deployment every replica's projector polls the same
feed. The scheduler does **not** solve this and must not pretend to — correctness for shared work lives in
the _consumer's schema_, exactly as studio ADR 0017 §2 mandates: a `dedup_key` unique constraint collapses
double-projection to one idempotent `INSERT`; `SELECT … FOR UPDATE SKIP LOCKED` gives exactly-one-worker
claim. No leader election, no `pg_try_advisory_lock` in the battery — building those in would duplicate a
correctness mechanism that already lives in the right place, and add a distributed-systems surface to a
package that should stay small and dumb.

## Alternatives considered

### `Scope.REQUEST`-style per-tick DI instance (the NestJS reflex)

Rejected for the same reason ADR 0003 rejected DI request scope for HTTP: it would put a "request" notion
inside the DI core and re-instantiate a subtree per tick. CLS gives the per-tick isolation with singletons
kept singleton — the tick binds its state to the async context, not to fresh instances.

### A first-class `TickInterceptor` taxonomy

Rejected for MVP (Rule of Three). One cross-cutting wrapper (the UoW) exists. A plain `around` hook does
the job with no new type; promote to an interceptor taxonomy only when a third tick concern (metrics,
tracing) actually shows up. Pre-building the taxonomy is speculative generality.

### Field-form `task()` markers scanned like routes

Considered for symmetry with routes (ADR 0004). Rejected for MVP: explicit `configure({ tasks })` matches
the ORM battery's explicit style, is DI-typed, and needs no new scan machinery. Field-form symmetry is a
later nicety, not a need.

### Cron support (`@Cron("*/5 * * * *")`)

Rejected for MVP. Studio ADR 0016 §5 puts recurrent/cron out of scope; the projector and sweep need a
plain interval. A `cron:` field can be added behind the same `ScheduledTask` API when a real recurring
need appears — no premature cron-parser dependency now. The scheduler is documented as a best-effort
interval poller, not a real-time/cron scheduler; `setInterval` drift under load is irrelevant to a poll
loop.

### Leader election / advisory locks in the battery

Rejected (see §6): it duplicates a correctness mechanism (`dedup_key` + `SKIP LOCKED`) that belongs in the
consumer's schema, and adds a distributed-systems surface. The scheduler stays naive by design.

## Consequences

- **Positive**: a scheduled tick is byte-for-byte a synthetic HTTP request — a projector reads/writes
  through a per-tick request-scoped UnitOfWork with no manager threading and no `.save()`, the exact
  ergonomics of a handler. This is the whole value proposition, and it only exists because it composes
  with the ORM battery via an `around` hook.
- **Positive**: the scheduler stays **decoupled from the ORM** — `mikroOrmUnitOfWork` ships from
  `@spinejs/mikro-orm`; the scheduler depends only on core + cls. Any `around` (tracing, metrics, a custom
  UoW) plugs in the same way.
- **Positive**: DI wiring is pure explicit-inject (flatten tokens → one factory → slice per task) — no
  container introspection, consistent with ADR 0007/0008.
- **Positive**: resilient by construction — one bad tick is caught and logged (timer survives), overlap
  defaults to skip (no pile-up), queue depth is bounded, timers are `unref()`ed, and `onStop` drains
  in-flight under the app's shutdown budget.
- **Negative**: no cron, no missed-tick catch-up, and `setInterval` drifts/coalesces under load — this is
  a best-effort poller, wrong for anything needing real-time or calendar scheduling. Documented as such.
- **Negative**: per-instance timers mean every replica ticks — safe only because the consumer's schema
  (`dedup_key` + `SKIP LOCKED`) enforces idempotency/exactly-once. A consumer that forgets those gets
  double execution; the battery cannot protect against it.
- **Caution**: `overlap: "queue"` past `maxQueued` (default 1000) **drops** ticks with a warning — a task
  persistently slower than its interval sheds work rather than growing memory. Size the interval to the
  work, or watch the warning.
