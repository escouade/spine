# @spinejs/scheduler

Periodic background tasks for SpineJS. Each tick runs in its own **CLS scope** — a _synthetic
request_ — so a task's services resolve request-scoped state (like a per-tick MikroORM UnitOfWork)
exactly the way an HTTP handler does, with **no manager threading**.

## Learn

Register tasks when you configure the module. A task declares how often it runs, what to inject, and
the work:

```ts
// app.module.ts
import { SchedulerModule } from "@spinejs/scheduler";
import { mikroOrmUnitOfWork } from "@spinejs/mikro-orm"; // per-tick UnitOfWork (an `around` hook)

@Module({
  imports: [
    MikroOrmModule.configure({
      /* … */
    }),
    SchedulerModule.configure({
      imports: [JobsModule], // the modules that export the tokens used below
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

The task's service reads and writes through the request-scoped `EntityManager` — no manager
threading, no explicit `.save()`, identical to an HTTP handler:

```ts
// projector.ts
export class Projector {
  static inject = [EntityManager] as const; // resolves to THIS tick's fork, via CLS
  constructor(private em: EntityManager) {}
  async pollAndCreateJobs() {
    const events = await this.em.find(OutboxCursor, {});
    for (const e of events) this.em.create(Job, project(e)); // flushed when the tick commits
  }
}
```

## Do

**Overlap.** By default a tick that fires while the previous one is still running is **skipped** — a
poll loop never piles up. Use `overlap: "queue"` to serialize instead:

```ts
{ name: "report", everyMs: 60_000, overlap: "queue", run: () => report() }
```

**No dependencies.** Omit `inject` (and `imports`) for a self-contained task:

```ts
{ name: "heartbeat", everyMs: 10_000, run: () => console.log("alive") }
```

**Custom `around`.** An `around` hook wraps the run inside the CLS scope — compose tracing, metrics,
or your own unit-of-work:

```ts
const timed: TickAround = (next) => async () => {
  const t = performance.now();
  try {
    await next();
  } finally {
    console.log(`took ${performance.now() - t}ms`);
  }
};
```

**Shutdown.** On `onStop` the scheduler clears every timer and awaits the in-flight tick, so a
running projector finishes its batch. The app's shutdown timeout (default 5 s) is the hard backstop.

**Multi-instance.** The scheduler is deliberately naive: `setInterval` runs **per instance**. If you
run several replicas, every replica ticks. Correctness for shared work belongs in your schema (e.g. a
unique `dedup_key` + `SELECT … FOR UPDATE SKIP LOCKED`), **not** in a leader election here.

## Reference

`SchedulerModule.configure(options): DynamicModule`

| Option    | Type              | Notes                                                 |
| --------- | ----------------- | ----------------------------------------------------- |
| `tasks`   | `ScheduledTask[]` | The periodic tasks.                                   |
| `imports` | `ModuleEntry[]`   | Modules exporting the tokens used in tasks' `inject`. |

`ScheduledTask`

| Field     | Type                   | Default | Notes                                             |
| --------- | ---------------------- | ------- | ------------------------------------------------- |
| `name`    | `string`               | —       | Unique; used for logging and duplicate detection. |
| `everyMs` | `number`               | —       | Fixed delay between ticks (ms).                   |
| `run`     | `(...deps) => unknown` | —       | The work; receives resolved `inject` instances.   |
| `inject`  | `Token[]`              | `[]`    | Resolved by DI, passed to `run` in order.         |
| `overlap` | `"skip" \| "queue"`    | `skip`  | Behavior when a tick is still running.            |
| `seed`    | `() => ClsStore`       | `{}`    | Seed for this tick's CLS scope.                   |
| `around`  | `TickAround[]`         | `[]`    | Wrappers applied inside the CLS scope.            |

Cron expressions are out of scope for now (interval only); the projector / sweep use cases need a
plain interval. A `cron:` field can be added behind the same API when a real recurring need appears.
