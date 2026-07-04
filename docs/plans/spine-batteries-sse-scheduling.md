# Design — SpineJS server batteries: SSE fan-out + CLS-scoped scheduling

- **Date**: 2026-07-04
- **Status**: design proposal — input for **spine ADR 0017** (SSE) + **spine ADR 0018** (scheduling).
  Also feeds the re-evaluation of **studio ADR 0017** (jobs-service framework: NestJS vs Spine).
- **Author**: Winston (architect)
- **Companion**: [orm-mikro-vs-typeorm-bench.md](./orm-mikro-vs-typeorm-bench.md) (battery 1/3, → spine ADR 0016)

## 0. TL;DR

Two server "batteries" are missing from spine before it can host a Node backend service:
**SSE** (server→client push) and **scheduling** (periodic background work). This doc designs both
against spine's actual grain and states plainly where they land.

- **SSE** → additions to `@spinejs/http-gateway` (HTTP-only, `gateway-core` untouched). A new
  `sse()` route marker + a batteries-included **fan-out hub**. Streams via Hono's `streamSSE`; reuses
  the route's guards + input validation; **bypasses** the `Envelope` buffering (a stream can't be one
  buffered value) and the interceptor chain (no per-connection CLS scope — the handler gets `ctx`
  directly; a long-lived stream must not hold scoped resources open).
- **Scheduling** → a new transport-agnostic package `@spinejs/scheduler`. Its differentiator, and the
  reason to build it in spine at all: **each tick runs in a fresh CLS scope → a request-scoped
  UnitOfWork for free**, composing with the ORM battery. A tick becomes a _synthetic request_.
- **Sequencing (the honest part)**: shipping these does **not** flip studio ADR 0017 for the
  jobs-service **now**. That service is WI-D, off the golden-path critical path, and studio ADR 0017 §3
  explicitly mandates dogfooding spine **cold**, not under MVP urgency. Build these two batteries cold
  and isolated; re-open the studio decision at WI-D with a real bench — not before.

**The one coherent thesis** these three batteries share: _one request-scoped UnitOfWork model, via
spine CLS, across HTTP requests, scheduled ticks, and (later) job execution_ — with **zero manager
threading**. That is spine's server story. If that thesis is not worth paying for, neither battery is
worth building, and NestJS's batteries win on volume.

**Proof.** The risky half of that thesis — _scheduler tick = CLS-scoped UoW_ — plus the SSE fan-out hub
are spiked **4/4 green** (runnable, zero deps): see §2.1. The mechanism holds; what's left is packaging
and the HTTP wire, not invention.

---

## 1. Framing — the three batteries

Studio ADR 0017 rejected dogfooding spine for the jobs-service on one concrete ground: _"batteries
manquantes (ORM, SSE, scheduling) → plomberie à reconstruire sur le chemin critique MVP."_ Three gaps.

| Battery        | Status                            | Lands as                                      |
| -------------- | --------------------------------- | --------------------------------------------- |
| **ORM**        | ✅ designed (spike 4/4, ADR 0016) | `@spinejs/mikro-orm` (request-scoped UoW/CLS) |
| **SSE**        | ⬜ this doc, Part A               | `@spinejs/http-gateway` (+ `sse()` + hub)     |
| **Scheduling** | ⬜ this doc, Part B               | `@spinejs/scheduler` (new package)            |

One gap closed. This doc closes the design of the other two. Closing the _design_ is not the same as
closing the studio decision — see Part C.

---

## 2. Inherited invariants (spine's grain — what these modules must respect)

Verified against the current tree. These are hard constraints, not preferences.

1. **No rxjs, no Observable, Promise-only.** Spine has zero streaming/async-iterable/EventEmitter
   machinery today; `invoke` returns one awaited value. Any stream primitive we add is net-new — pick
   the lightest idiomatic one (**`AsyncIterable`**, zero deps).
2. **`gateway-core` is transport-agnostic and dep-free** (only `@spinejs/core`). Its `Envelope {ok,data}`
   contract and `DispatchTarget.invoke` "single awaited return" are shared by HTTP **and** Electron IPC.
   A long-lived stream is HTTP-only → it **must not** enter `gateway-core` (ADR 0002/0005).
3. **Routes are field-form markers** (ADR 0004): `get("/path", opts, (input, ctx) => …)`, discovered by
   scanning controller instance fields for a branded marker. New route kinds follow the same shape.
4. **CLS is the request scope** (ADR 0003): `cls.run(seed, fn)` opens a fresh store; `cls.set()` throws
   outside a scope. This is the seam scheduling reuses to make a tick a synthetic request.
5. **Module lifecycle** (ADR 0009/0010/0013): `static configure(): DynamicModule` for the DI surface +
   the same class `implements OnStart/OnStop` for background work; `stop()` is reverse-order and
   idempotent; `exit()` arms a `hardKill` at `shutdownTimeout` (5 s). Anything that starts a timer at
   `onStart` **must** clear it at `onStop` within that budget.
6. **Explicit typed DI** (ADR 0007/0008): positional `inject:` arrays of class/`InjectionToken` tokens,
   no `reflect-metadata`, no param decorators, no string DI tokens. **CLS keys are strings** (`get/set`
   are `keyof T & string`).

The mikro-orm package is the reference implementation of #5/#6 and the template for packaging (tsup dual
build delegating to `tsup.base.ts`, `publishConfig` swap to `dist`, `workspace:^` deps, explicit
re-exports in `index.ts`).

### 2.1 Spike — the differentiator, proven (4/4 green)

Before committing the design, the _new/risky_ mechanism was spiked runnable (the MikroORM engine +
per-request fork is already spiked 4/4 elsewhere — ADR 0016 — so this spike does **not** re-prove it).
See [`spine-batteries.spike.mjs`](./spine-batteries.spike.mjs) — `node docs/plans/spine-batteries.spike.mjs`.
It uses faithful stand-ins (`AsyncLocalStorage` for `ClsService`; a minimal identity-map/UoW for the
forked EM) so it runs with zero deps, and proves the **composition**, which is engine-agnostic:

1. **Tick = synthetic request** — a fresh CLS scope per tick; an `around` hook stashes a per-tick UoW in
   CLS; a projector reads it via CLS and mutates entities **with no manager threading and no `.save()`**;
   changes flush at tick commit.
2. **Atomic tick** — a failing tick rolls the UoW back; the DB is untouched (no partial writes escape).
3. **Overlap = skip** — a still-running tick is skipped, never stacked (a poll loop can't pile up).
4. **SSE fan-out** — one `publish` reaches every subscriber on a key; keys are isolated; disconnect
   unsubscribes (no leaked subscription).

Result: **4/4**. The scheduler-tick-as-CLS-scoped-UoW and the SSE hub both hold. The remaining work is
packaging + the HTTP wire (Hono `streamSSE`) + lifecycle/shutdown — not the core mechanism.

---

## 3. Part A — SSE fan-out battery (→ `@spinejs/http-gateway`, spine ADR 0017)

### 3.1 What the user writes

An SSE endpoint is a route whose handler returns an **async stream of events** instead of one value.
The typical case is _fan-out_: one server-side event reaches every open connection for a subject.

```ts
// jobs.controller.ts — the studio ADR 0016 §4 use case, spine-native
import { get, sse } from "@spinejs/http-gateway";
import { SseHub } from "@spinejs/http-gateway";

@Controller({ inject: [JobsHub] })
export class JobsController {
  // GET /jobs/stream  → text/event-stream, one connection per open session
  stream = sse("/jobs/stream", {}, (_input, ctx) =>
    this.jobs.subscribe(ctx.user.id)
  );
  //                                                 ^ returns AsyncIterable<SseEvent>
  constructor(private jobs: JobsHub) {}
}
```

```ts
// jobs.hub.ts — the batteries-included fan-out; server side calls publish()
export class JobsHub {
  private hub = new SseHub<string>(); // keyed by userId (events are always SseEvent)

  subscribe(userId: string) {
    return this.hub.subscribe(userId); // AsyncIterable<SseEvent> under the hood
  }
  // called by the LISTEN/NOTIFY bridge on every job write → fans out to all of the user's tabs
  onJobWrite(userId: string, state: JobState) {
    this.hub.publish(userId, { event: state.status, data: state });
  }
}
```

That is the whole surface: **`sse()`** to declare the endpoint, **`SseHub`** to fan out. `GET
/jobs/stream` broadcasting `job.created/updated/completed/failed/awaiting-input` to all of an assignee's
sessions (studio ADR 0016 §4) is ~15 lines.

`SseEvent`:

```ts
interface SseEvent {
  data: unknown; // JSON-serialized to the `data:` field
  event?: string; // `event:` name (defaults to "message")
  id?: string; // `id:` — surfaces as Last-Event-ID on reconnect
  retry?: number; // client reconnect backoff hint (ms)
}
```

### 3.2 How it works behind

**Placement.** Everything lives in `packages/http-gateway`; `gateway-core` is untouched. A
`LoadedRoute` already carries its **resolved guard instances**, so the SSE path runs them inline — no
streaming type ever leaks into the transport-agnostic core.

**The `sse()` marker.** Mirrors `get`/`post`: builds a `RouteMarker` with an extra HTTP-meta flag
`sse: true` (extends `HttpRouteMeta`). Discovery via the existing `getRoutes()` field scan — unchanged.

**Streaming dispatch (why not the normal pipeline).** The normal path is
`dispatch → Envelope{ok,data} → new Response(JSON.stringify(envelope))` — one buffered value. An SSE
response is N values over a long-lived connection; it cannot be an `Envelope`. So `HttpGateway.bind`
**branches on `meta.sse`** into a parallel streaming path that reuses the auth/context machinery but
replaces the "buffer one envelope" tail:

```ts
// http.gateway.ts — new branch in bind(), HTTP-package-local
if (meta?.sse) {
  this.app.on(method, path, (c) => this.dispatchSse(route, c));
  return;
}

// dispatchSse: guards + validation up front (failure → JSON error, no stream), then stream.
private async dispatchSse(route, c): Promise<Response> {
  const ctx = this.contextFactory.create(c);
  try {
    for (const guard of route.guards) {            // guards are already-resolved instances
      if (!(await guard.canActivate(ctx))) throw new UnauthorizedError();
    }
    const raw = await extractInput(c, "GET");
    const input = route.input ? this.validator.validate(route.input, raw) : raw;
    const events = (await route.invoke(ctx, input)) as AsyncIterable<SseEvent>;
    return streamSSE(c, (stream) => pumpSse(stream, events, this.sseHeartbeatMs));
  } catch (err) {                                   // nothing streamed yet → normal JSON envelope
    const code = this.errorMapper.toCode(err);
    return new Response(JSON.stringify({ ok: false, code }), {
      status: this.statusMapper(code),
      headers: { "Content-Type": "application/json" },
    });
  }
}

// pumpSse: iterate → writeSSE until the client disconnects; `: ping` keep-alive; return() unsubscribes.
async function pumpSse(stream, events, heartbeatMs): Promise<void> {
  const it = events[Symbol.asyncIterator]();
  const hb = heartbeatMs > 0 ? setInterval(() => void stream.write(": ping\n\n"), heartbeatMs) : undefined;
  hb?.unref?.();
  stream.onAbort(() => void it.return?.());         // client gone → unsubscribe
  try {
    for (;;) {
      const { value, done } = await it.next();
      if (done || stream.aborted) break;
      await stream.writeSSE({ data: JSON.stringify(value.data), event: value.event, id: value.id });
    }
  } finally {
    if (hb) clearInterval(hb);
    await it.return?.();
  }
}
```

Key points:

- **Hono already ships `streamSSE`** (`hono/streaming`) — we do not touch Node `ServerResponse`. The
  transport stays Hono-shaped.
- **Guards + validation are reused; the interceptor chain is not.** An SSE connection is authenticated
  once at open (guards) and its `params`/`query` validated, then it streams. It runs **no** interceptor
  chain and opens **no** per-connection CLS scope: the handler receives `ctx` directly, and a
  long-lived stream must not hold scoped resources (a DB transaction, a CLS store) open for its whole
  lifetime. (Publishing data is the writer's job, on the POST side.)
- **Disconnect → unsubscribe.** `stream.onAbort` calls the async iterator's `return()`, which is where
  `SseHub` removes the subscriber. No leaked subscriptions.
- **Heartbeat** keeps intermediaries from killing an idle connection.

**The `SseHub<K = string>`** — the fan-out primitive, ~100 lines, zero deps (events are always
`SseEvent`, so only the key is generic):

```ts
class SseHub<K = string> {
  private subs = new Map<K, Set<SseSubscriber>>();
  subscribe(key: K): AsyncIterable<SseEvent> {
    /* bounded async queue; on return() → unsubscribe */
  }
  publish(key: K, event: SseEvent): void {
    /* push to every subscriber under key */
  }
  subscriberCount(key: K): number {
    /* introspection / tests */
  }
  close(): void {
    /* end all iterators */
  }
}
```

Each `Subscriber` is a tiny async queue (buffer + resolver). `subscribe()` yields until the consumer's
`for await` breaks (client disconnect), then unregisters.

### 3.3 Trade-offs to decide (spine ADR 0017)

- **Package placement**: fold SSE + hub into `@spinejs/http-gateway` (fewer packages; SSE _is_ an HTTP
  concern) **vs** a new `@spinejs/sse` (keeps http-gateway lean; the hub is reusable pub/sub).
  → **Recommend fold for MVP** (Rule of Three): the hub has exactly one consumer today; extract when a
  second appears.
- **Backpressure**: a slow client's queue can grow unbounded. Options: bounded queue with drop-oldest +
  a `lag` marker, or disconnect the slow client. → **Recommend bounded + drop-oldest** (SSE is a
  best-effort wakeup per studio ADR 0016; the client re-polls on reconnect). Must be explicit, not
  accidental.
- **Last-Event-ID replay**: read the header, pass to the handler for optional replay. → **Ship as a
  documented hook, not a guarantee** (studio ADR 0016: SSE never guarantees delivery; fallback is poll).
- **Guard evaluation**: SSE needs guards without the `Envelope` tail. **Resolved as shipped:** a
  `LoadedRoute` already carries its resolved guard instances, so the SSE path runs
  `guard.canActivate(ctx)` inline — no `gateway-core` change, no duplicated resolution.

### 3.4 vs NestJS `@Sse()`

Nest's `@Sse()` returns an `Observable<MessageEvent>` — a **per-connection** stream. Fan-out to N
sessions you build yourself (an rxjs `Subject` per key + cleanup). Spine ships the **hub** as the
battery, so the studio use case (broadcast a job write to all of a user's tabs) is declarative. Cost:
spine has no rxjs, so we own ~100 lines of async-queue code Nest gets from rxjs. Fair trade — it's the
part studio would hand-roll on Nest anyway (ADR 0016 §4: "LISTEN/NOTIFY alimente la SSE").

---

## 4. Part B — CLS-scoped scheduling battery (→ `@spinejs/scheduler`, spine ADR 0018)

### 4.1 What the user writes

Periodic background work — the studio ADR 0017 §2 cases are the **outbox projector** (poll a feed,
create jobs) and the **lease sweep** (requeue expired leases).

```ts
// app.module.ts — register periodic tasks; each runs in its own CLS scope
import { SchedulerModule } from "@spinejs/scheduler";
import { mikroOrmUnitOfWork } from "@spinejs/mikro-orm"; // supplies the per-tick UoW wrapper

@Module({
  imports: [
    MikroOrmModule.configure({
      /* … */
    }),
    SchedulerModule.configure({
      tasks: [
        {
          name: "outbox-projector",
          everyMs: 2_000,
          inject: [Projector],
          run: (p: Projector) => p.pollAndCreateJobs(), // no em threading — see 4.2
          around: [mikroOrmUnitOfWork],
        }, // tick = request-scoped UoW
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

```ts
// projector.ts — reads/writes through the request-scoped EM, exactly like an HTTP handler
export class Projector {
  static inject = [EntityManager] as const; // resolves to THIS tick's fork (via CLS)
  constructor(private em: EntityManager) {}
  async pollAndCreateJobs() {
    const events = await this.em.find(OutboxCursor, {
      /* … */
    });
    for (const e of events) this.em.create(Job, project(e)); // dirty-tracked, flushed at tick commit
  }
}
```

The projector reads and writes with **no manager threading and no explicit `.save()`** — identical
ergonomics to an HTTP request handler. That is the entire point of building scheduling _in spine_.

### 4.2 How it works behind — the differentiator

**A tick is a synthetic request.** An HTTP request gets: a fresh CLS scope (`ClsInterceptor`) → a forked
EM in CLS (`MikroOrmInterceptor`) → handler runs → commit. A scheduled tick reproduces exactly that,
without a gateway:

```ts
// scheduler.module.ts — lifecycle-driven, ADR 0010/0013 compliant
@Module({ inject: [ClsService, SchedulerRegistry] })
export class SchedulerModule implements OnStart, OnStop {
  static configure(opts: SchedulerOptions): DynamicModule {
    /* imports:[ClsModule], providers… */
  }

  onStart() {
    for (const task of this.registry.tasks) {
      const boundRun = () => task.run(...this.resolve(task.inject)); // DI-resolved deps
      const wrapped = compose(task.around, boundRun); // around hooks → UoW etc.
      task.timer = setInterval(() => this.tick(task, wrapped), task.everyMs);
    }
  }
  private async tick(task, wrapped) {
    if (task.running && task.overlap !== "queue") return; // skip overlapping ticks
    task.running = true;
    try {
      await this.cls.run(task.seed?.() ?? {}, wrapped);
    } catch (e) {
      // ← fresh CLS scope per tick
      this.log.error(`task ${task.name} failed`, e);
    } finally {
      // one bad tick ≠ crash
      task.running = false;
    }
  }
  async onStop() {
    for (const t of this.registry.tasks) clearInterval(t.timer); // stop scheduling
    await Promise.all(this.registry.tasks.map((t) => t.inflight)); // drain in-flight (bounded by hardKill)
  }
}
```

`mikroOrmUnitOfWork` is an `around` hook that does, per tick, what `MikroOrmInterceptor` does per
request: `em = orm.em.fork(); cls.set(EM, em); begin() … commit()/rollback()`. Because `cls.set` runs
_inside_ the scheduler's `cls.run`, it just works. Same UoW, same identity map, same "no `.save()`".

**Correctness properties:**

- **Overlap = skip (default).** A projector poll must never stack on a slow previous poll. `queue` is
  opt-in for tasks that must not miss a beat.
- **One bad tick never crashes the app** — the tick is try/caught and logged; the timer survives.
- **Graceful shutdown (ADR 0013).** `onStop` clears timers (no new ticks) then awaits the in-flight
  tick. The app's `hardKill` (5 s) is the ultimate backstop, so a wedged tick can't hang shutdown.

### 4.3 Multi-replica — deliberately naive (studio ADR 0017 §2)

`setInterval` runs **per instance**. In multi-replica k8s, every replica's projector polls the same
outbox feed. **The scheduler does not solve this and must not pretend to.** Correctness lives in the
_consumer's_ schema, exactly as studio ADR 0017 §2 mandates:

- `dedup_key` unique constraint → double-projection collapses to one idempotent `INSERT`.
- `SKIP LOCKED` claim → exactly one worker runs a job.

No leader election, no `pg_try_advisory_lock` in the battery. Building those in would be _wrong_ — it
duplicates a correctness mechanism that already lives in the right place. The scheduler stays dumb by
design. (This is a feature: it means the battery is small and has no distributed-systems surface.)

### 4.4 Trade-offs to decide (spine ADR 0018)

- **Interval-only vs cron.** Studio ADR 0016 §5 puts recurrent/cron **out of MVP scope** (the projector
  - sweep need a plain interval). → **Ship interval-only**; leave a documented seam for a `cron:`
    field backed by a small cron parser when a real recurring need appears. No premature cron dep.
- **`around` hook vs a `TickInterceptor` taxonomy.** The UoW composition could be a first-class
  interceptor type mirroring `GatewayInterceptor`. → **Recommend the plain `around` hook for MVP**
  (Rule of Three): one wrapper (UoW) exists today. Promote to an interceptor taxonomy only when a third
  cross-cutting tick concern (metrics? tracing?) shows up.
- **Registration: explicit `configure({tasks})` vs field-form `task()` markers** scanned like routes.
  → **Recommend explicit `tasks` for MVP** (matches mikro-orm's explicit style, DI-typed, no new
  scan machinery). Field-form symmetry with routes is a later nicety, not a need.
- **Missed-tick / drift.** `setInterval` drifts and coalesces under load. → **Document it as a
  best-effort poller, not a real-time scheduler.** For the projector/sweep, drift is irrelevant.

### 4.5 vs `@nestjs/schedule`

`@nestjs/schedule` gives `@Cron()/@Interval()/@Timeout()` + a `SchedulerRegistry`. What it does **not**
give: a per-tick request scope. On Nest, a `@Cron` projector that wants a request-scoped EM/UoW wires it
by hand (or uses `@Injectable({ scope: REQUEST })` gymnastics that don't naturally apply to a timer).
Spine's battery makes the tick a synthetic request natively — the projector's data access is
byte-for-byte the HTTP handler's. That symmetry is the whole value proposition; without the ORM battery
underneath it, this advantage evaporates and `@nestjs/schedule` (mature, cron-complete) wins.

---

## 5. Part C — Sequencing & the studio ADR 0017 flip

**Does landing SSE + scheduling flip studio ADR 0017 (jobs-service on spine)? No — not now.** Three
independent reasons, each sufficient:

1. **Not on the critical path.** The jobs-service is **WI-D**. The golden path A→B→C runs on the
   in-memory registry (frozen plan decision #3). The broker/framework debate only becomes real at WI-D
   — there is nothing to unblock today.
2. **Studio ADR 0017 §3 already legislated this.** Dogfooding spine must happen **cold**, on an assumed
   server need, **not** "dans l'urgence d'un MVP ni au service d'un composant susceptible d'être
   remplacé" (the jobs transport may migrate to Kafka). Rushing spine onto the jobs-service now is
   exactly the anti-pattern that ADR forbids.
3. **NestJS is still ahead on the rest.** Even with all three batteries, the jobs-service also leans on
   shared JWT guards (`libs/auth`), DTO/Swagger conventions (studio ADR 0009), and TypeORM's ecosystem.
   And these two spine batteries are **new surface** (SSE stream lifecycle, scheduler shutdown drain) —
   new-surface risk on a service you'd rather ship boring.

**What this doc _is_ for, then:** it lets us build both batteries **cold and isolated** (this worktree,
off the studio critical path) — which is precisely the "extraction délibérée des bons patterns plus
tard, à froid" that studio ADR 0017 §3 _endorses_. Designing them now:

- **de-risks** the eventual flip (the plumbing is real, not hypothetical),
- **sizes** it (rough MVP effort: SSE ≈ 2–3 d incl. hub + tests; scheduler ≈ 2–3 d incl. lifecycle +
  drain + tests — both greenfield, no migration),
- and keeps spine's server thesis **coherent** (one CLS UoW across request + tick + job).

**What would actually flip studio ADR 0017 at WI-D:** a genuine server need where the request-scoped
UoW _across request, tick, and job execution_ pays for itself, **and** these batteries have proven
themselves cold (used somewhere real first). At that point, re-bench spine vs NestJS for the
jobs-service with numbers, honoring studio ADR 0017's own flip conditions. **Not before.**

**Recommendation.** Build `@spinejs/scheduler` and the http-gateway SSE additions cold, MVP-scoped, in
spine. Write spine ADR 0017 + 0018 from this doc once the trade-offs in §3.3 / §4.4 are chosen. Leave
studio ADR 0017 **Accepted / NestJS** until WI-D forces a real re-bench.

---

## 6. Reference

### 6.1 SSE API surface (`@spinejs/http-gateway`)

| Symbol                     | Shape                                                                      |
| -------------------------- | -------------------------------------------------------------------------- |
| `sse(path, opts, handler)` | `handler: (input, ctx) => AsyncIterable<SseEvent>` → `RouteMarker`         |
| `SseEvent`                 | `{ data: unknown; event?: string; id?: string; retry?: number }`           |
| `SseHub<K, E>`             | `subscribe(key): AsyncIterable<SseEvent>` · `publish(key, ev)` · `close()` |
| HTTP meta                  | `HttpRouteMeta` gains `sse?: true`                                         |
| gateway-core (pure add)    | `runGuards(target, ctx): Promise<void>` (shared by buffered + SSE paths)   |
| Config                     | `heartbeatMs` (default 15_000), backpressure policy (bounded/drop-oldest)  |

### 6.2 Scheduler API surface (`@spinejs/scheduler`)

| Symbol                         | Shape                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `SchedulerModule.configure(o)` | `o: { tasks: ScheduledTask[] }` → `DynamicModule` (`imports:[ClsModule]`)             |
| `ScheduledTask`                | `{ name; everyMs; inject?; run(...deps); overlap?: 'skip'\|'queue'; seed?; around? }` |
| `around` hook                  | `(next: () => Promise<void>) => () => Promise<void>` (UoW, tracing, …)                |
| `mikroOrmUnitOfWork`           | `around` hook exported by `@spinejs/mikro-orm` (fork EM into CLS + begin/commit)      |
| Lifecycle                      | `onStart` arms timers · `onStop` clears + drains in-flight (≤ `shutdownTimeout`)      |

### 6.3 Package layout (mirrors `@spinejs/mikro-orm`)

```
packages/scheduler/
  package.json  project.json  tsconfig.json  tsup.config.ts  vitest.config.ts  README.md
  src/index.ts                          # explicit re-exports, no export *
  src/scheduler.module.ts   + .spec.ts  # configure() + OnStart/OnStop
  src/scheduler.registry.ts + .spec.ts  # task table, overlap/inflight state
  src/scheduler.options.ts              # ScheduledTask, around, tokens (InjectionToken)
```

SSE additions are in-place in `packages/http-gateway/src/` (`http-routes.ts` gains `sse()`;
`http.gateway.ts` gains the streaming branch; new `sse-hub.ts` + specs).

### 6.4 Docs obligation

Per CLAUDE.md: shipping either module changes the public API → Docusaurus **EN + FR** (`apps/docs-site`

- i18n/fr) and the relevant READMEs, in the pedagogical _learn → do → reference_ style. Not required for
  this design doc; required when the code lands.

## Sources (internal)

- Spine grain verified against current tree: `packages/http-gateway/src/http-routes.ts`,
  `packages/gateway-core/src/{pipeline,route-marker,ports,gateway.types}.ts`,
  `packages/http-gateway/src/http.gateway.ts`, `packages/core/src/{app,module/*}.ts`,
  `packages/cls/src/*.ts`, `packages/mikro-orm/src/*` (battery template).
- Spine ADRs 0002/0004/0005 (gateway/transport/routes), 0003 (CLS), 0007/0008 (DI), 0009/0010/0013
  (module lifecycle + shutdown), 0016 (ORM, pending).
- Studio ADR 0016 (event-system durable triggers — SSE §4, scheduling §5) + ADR 0017 (NestJS vs Spine).
- Hono `streamSSE` (`hono/streaming`) — already a transitive dep of `@hono/node-server`.
