---
sidebar_position: 4
---

# Scheduler (periodic tasks)

`@spinejs/scheduler` runs **periodic background tasks**. Each tick runs in its own
[CLS scope](./cls) — a _synthetic request_ — so a task's services resolve request-scoped state (like a
per-tick MikroORM UnitOfWork) exactly the way an HTTP handler does, with **no manager threading**. That
symmetry is the whole reason to schedule work _inside_ SpineJS.

## Registering a task

Register tasks when you configure the module. A task declares how often it runs, what to inject, and the
work to do. The modules that **export** the injected tokens come in via `imports`:

```typescript
// app.module.ts
import { Module } from "@spinejs/core";
import { SchedulerModule } from "@spinejs/scheduler";
import { mikroOrmUnitOfWork } from "@spinejs/mikro-orm"; // per-tick UnitOfWork (an `around` hook)
import { JobsModule } from "./jobs.module";
import { Projector } from "./projector";
import { Leases } from "./leases";

@Module({
  imports: [
    SchedulerModule.configure({
      imports: [JobsModule], // exports Projector, Leases
      tasks: [
        {
          name: "outbox-projector",
          everyMs: 2_000,
          inject: [Projector],
          run: (p: Projector) => p.pollAndCreateJobs(),
          around: [mikroOrmUnitOfWork], // tick = request-scoped UnitOfWork
        },
        {
          name: "lease-sweep",
          everyMs: 5_000,
          inject: [Leases],
          run: (l: Leases) => l.requeueExpired(),
          around: [mikroOrmUnitOfWork],
        },
      ],
    }),
  ],
})
export class AppModule {}
```

The task's service reads and writes through the request-scoped `EntityManager` — no manager threading, no
explicit `.save()`, identical to an HTTP handler:

```typescript
// projector.ts
import { EntityManager } from "@mikro-orm/core";

export class Projector {
  static inject = [EntityManager] as const; // resolves to THIS tick's fork, via CLS
  constructor(private readonly em: EntityManager) {}

  async pollAndCreateJobs() {
    const events = await this.em.find(OutboxCursor, {});
    for (const e of events) this.em.create(Job, project(e)); // flushed when the tick commits
  }
}
```

:::info `mikroOrmUnitOfWork` ships with `@spinejs/mikro-orm`
The scheduler itself has **no** ORM dependency. `mikroOrmUnitOfWork` is just an `around` hook supplied by
the ORM battery; any `around` (tracing, metrics, your own unit-of-work) composes the same way — see
[Custom `around`](#custom-around) below.
:::

## Do

### Overlap

By default a tick that fires while the previous one is still running is **skipped** — a poll loop never
piles up. Use `overlap: "queue"` to serialize instead (the queue is depth-bounded; see the reference):

```typescript
{ name: "report", everyMs: 60_000, overlap: "queue", run: () => report() }
```

### No dependencies

Omit `inject` (and `imports`) for a self-contained task:

```typescript
{ name: "heartbeat", everyMs: 10_000, run: () => console.log("alive") }
```

### Custom `around`

An `around` hook wraps the run **inside** the CLS scope — compose tracing, metrics, or your own
unit-of-work. It takes the next function and returns the wrapped one:

```typescript
import type { TickAround } from "@spinejs/scheduler";

const timed: TickAround = (next) => async () => {
  const start = performance.now();
  try {
    await next();
  } finally {
    console.log(`took ${performance.now() - start}ms`);
  }
};
```

### Seed the scope

`seed()` provides the initial CLS store for the tick's scope — the tick's equivalent of an HTTP request's
seeded context:

```typescript
{ name: "audited", everyMs: 30_000, seed: () => ({ actor: "scheduler" }), run: () => … }
```

### Shutdown

On `onStop` the scheduler clears every timer and awaits the in-flight tick, so a running projector
finishes its batch. The app's [shutdown timeout](../core/lifecycle) (default 5 s) is the hard backstop.

### Multi-instance

The scheduler is deliberately naive: `setInterval` runs **per instance**. If you run several replicas,
every replica ticks. Correctness for shared work belongs in your **schema** (e.g. a unique `dedup_key` +
`SELECT … FOR UPDATE SKIP LOCKED`), **not** in a leader election here. This keeps the battery small and
free of distributed-systems surface.

## Reference

`SchedulerModule.configure(options): DynamicModule`

| Option    | Type              | Notes                                                 |
| --------- | ----------------- | ----------------------------------------------------- |
| `tasks`   | `ScheduledTask[]` | The periodic tasks.                                   |
| `imports` | `ModuleEntry[]`   | Modules exporting the tokens used in tasks' `inject`. |

`ScheduledTask`

| Field     | Type                   | Default | Notes                                               |
| --------- | ---------------------- | ------- | --------------------------------------------------- |
| `name`    | `string`               | —       | Unique; used for logging and duplicate detection.   |
| `everyMs` | `number`               | —       | Fixed delay between ticks (ms); must be positive.   |
| `run`     | `(...deps) => unknown` | —       | The work; receives the resolved `inject` instances. |
| `inject`  | `Token[]`              | `[]`    | Resolved by DI, passed to `run` in order.           |
| `overlap` | `"skip" \| "queue"`    | `skip`  | Behavior when a tick is still running.              |
| `seed`    | `() => ClsStore`       | `{}`    | Seed for this tick's CLS scope.                     |
| `around`  | `TickAround[]`         | `[]`    | Wrappers applied inside the CLS scope.              |

`TickAround` — `(next: () => Promise<void>) => () => Promise<void>`. Applied outermost-first.

**Overlap `queue`** serializes ticks; the pending chain is bounded (default `1000`). A task persistently
slower than its interval sheds ticks (drop-oldest + a warning) rather than growing memory.

Cron expressions are out of scope for now (interval only) — the projector / sweep use cases need a plain
interval. The design rationale is recorded in ADR 0018 (`docs/adr/0018-cls-scoped-scheduling.md`).
