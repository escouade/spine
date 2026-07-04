// Spike — SpineJS server batteries differentiator (SSE fan-out + CLS-scoped scheduling)
// Backs docs/plans/spine-batteries-sse-scheduling.md. Runnable: `node docs/plans/spine-batteries.spike.mjs`.
//
// What this PROVES (the new/risky mechanism), NOT what it re-proves:
//   - The MikroORM engine + per-request EM fork is ALREADY spiked 4/4 (see orm bench doc / ADR 0016).
//   - So here we prove the SCHEDULER composition: a tick = a synthetic request. A fresh CLS scope per
//     tick, an `around` hook that stashes a per-tick UnitOfWork into CLS, and a service that reads it
//     via CLS with NO manager threading and NO explicit .save(). Plus the SSE fan-out hub.
//
// Faithful stand-ins (so the spike needs zero workspace/npm deps and runs instantly):
//   - `Cls` mirrors @spinejs/cls ClsService (ADR 0003): run(seed,fn) / get / set(throws outside scope).
//   - `UnitOfWork` models @spinejs/mikro-orm's forked EntityManager contract (identity map + flush on
//     commit + discard on rollback). The real one is MikroORM; the composition under test is identical.

import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";

// ── Stand-in for @spinejs/cls ClsService (API per packages/cls/src/cls.service.ts) ────────────────
class Cls {
  #als = new AsyncLocalStorage();
  run(seed, fn) {
    return this.#als.run({ ...seed }, fn);
  }
  get active() {
    return this.#als.getStore() !== undefined;
  }
  get(k) {
    return this.#als.getStore()?.[k];
  }
  set(k, v) {
    const s = this.#als.getStore();
    if (!s) throw new Error(`Cls.set(${k}) called outside an active scope`);
    s[k] = v;
  }
}

// ── Stand-in for a forked MikroORM EntityManager (identity map + UoW) ─────────────────────────────
class UnitOfWork {
  constructor(store) {
    this.store = store; // shared "DB"
    this.identity = new Map(); // per-tick identity map (dies with the scope)
  }
  find(id) {
    if (!this.identity.has(id) && this.store.has(id))
      this.identity.set(id, { ...this.store.get(id) });
    return this.identity.get(id);
  }
  create(id, data) {
    const e = { id, ...data };
    this.identity.set(id, e);
    return e;
  }
  commit() {
    for (const e of this.identity.values()) this.store.set(e.id, { ...e }); // flush identity map (dirty-tracking)
  }
  rollback() {
    this.identity.clear(); // discard; nothing reaches the store
  }
}

const EM = "spike:em"; // CLS key — string (ClsService.get/set are `keyof T & string`)

// ── `around` hook: per-tick UnitOfWork. Mirrors MikroOrmInterceptor, but for a tick, not a request ─
const withUnitOfWork = (cls, db) => (next) => async () => {
  const uow = new UnitOfWork(db); // "fork" — fresh identity map / UoW
  cls.set(EM, uow); // spine CLS backs the UoW (requires an active scope → opened by the scheduler)
  try {
    await next();
    uow.commit(); // flush at end of tick — like commit()/flush() at end of request
  } catch (e) {
    uow.rollback();
    throw e;
  }
};

// ── The scheduler tick, distilled: fresh CLS scope + `around` chain + overlap policy ──────────────
function makeScheduler(cls) {
  const compose = (arounds, run) => arounds.reduceRight((n, a) => a(n), run);
  return {
    async runTick(task) {
      if (task.running && task.overlap !== "queue") return "skipped"; // overlap = skip (default)
      task.running = true;
      try {
        const wrapped = compose(task.around ?? [], task.run);
        await cls.run(task.seed?.() ?? {}, wrapped); // ← each tick is its own CLS scope
        return "ran";
      } finally {
        task.running = false;
      }
    },
  };
}

// ── Projector-like service: reads the tick-scoped UoW via CLS. NO manager threading, NO .save() ───
class Projector {
  constructor(cls) {
    this.cls = cls;
  }
  get em() {
    return this.cls.get(EM); // resolves to THIS tick's UoW (via CLS) — exactly like an HTTP handler
  }
  poll() {
    const cursor =
      this.em.find("cursor") ?? this.em.create("cursor", { at: 0 });
    cursor.at += 1; // dirty-tracked; flushed at tick commit — never call .save()
    this.em.create(`job:${cursor.at}`, { status: "pending" });
  }
}

// ── The SSE fan-out hub (prototype of SseHub<K,E>) ────────────────────────────────────────────────
class SseHub {
  #subs = new Map(); // key -> Set<sub>
  subscribe(key) {
    const buf = [];
    let resolve = null;
    let closed = false;
    const sub = {
      push: (ev) => {
        if (resolve) {
          resolve({ value: ev, done: false });
          resolve = null;
        } else buf.push(ev);
      },
    };
    if (!this.#subs.has(key)) this.#subs.set(key, new Set());
    this.#subs.get(key).add(sub);
    const remove = () => this.#subs.get(key)?.delete(sub);
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            closed
              ? Promise.resolve({ value: undefined, done: true })
              : buf.length
              ? Promise.resolve({ value: buf.shift(), done: false })
              : new Promise((r) => (resolve = r)),
          return: () => {
            remove(); // client disconnect → unsubscribe (no leaked subscription)
            closed = true;
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
  }
  publish(key, ev) {
    for (const s of this.#subs.get(key) ?? []) s.push(ev);
  }
  subscriberCount(key) {
    return this.#subs.get(key)?.size ?? 0;
  }
}

// ══ PROOFS ════════════════════════════════════════════════════════════════════════════════════════
let pass = 0;
const ok = (n, msg) => {
  pass++;
  console.log(`  ✓ ${n}. ${msg}`);
};

async function main() {
  const cls = new Cls();
  const db = new Map();
  const sched = makeScheduler(cls);
  const projector = new Projector(cls);

  // 1 — tick runs in a fresh CLS scope; the UoW commits mutations with NO .save()
  const task = {
    name: "projector",
    overlap: "skip",
    around: [withUnitOfWork(cls, db)],
    run: () => projector.poll(),
  };
  assert.equal(cls.active, false, "no scope outside a tick");
  await sched.runTick(task);
  assert.equal(
    db.get("cursor").at,
    1,
    "cursor mutation persisted without save()"
  );
  assert.equal(
    db.get("job:1").status,
    "pending",
    "created job flushed at tick commit"
  );
  await sched.runTick(task);
  assert.equal(
    db.get("cursor").at,
    2,
    "second tick = second fresh UoW, sees committed state"
  );
  ok(
    1,
    "tick = synthetic request: CLS-scoped UoW, dirty-tracked, no manager threading, no .save()"
  );

  // 2 — a failing tick rolls back: no partial writes escape the scope
  const before = db.get("cursor").at;
  const boom = {
    name: "boom",
    overlap: "skip",
    around: [withUnitOfWork(cls, db)],
    run: () => {
      projector.poll(); // would bump cursor to 3 + create job:3 ...
      throw new Error("tick failed");
    },
  };
  await assert.rejects(sched.runTick(boom), /tick failed/);
  assert.equal(db.get("cursor").at, before, "rollback discarded the increment");
  assert.equal(db.has("job:3"), false, "rollback discarded the created job");
  ok(2, "failing tick → UoW rollback; the DB is untouched (atomic per tick)");

  // 3 — overlap = skip: a still-running tick is skipped, never stacked (critical for a poll loop)
  let entered = 0;
  const slow = {
    name: "slow",
    overlap: "skip",
    around: [],
    run: () =>
      new Promise((r) => {
        entered++;
        setTimeout(r, 40);
      }),
  };
  const p1 = sched.runTick(slow); // starts, running = true
  const r2 = await sched.runTick(slow); // fires again immediately while p1 in-flight
  assert.equal(r2, "skipped", "overlapping tick is skipped");
  assert.equal(entered, 1, "the skipped tick never entered run()");
  assert.equal(await p1, "ran", "the in-flight tick completes");
  ok(
    3,
    "overlap=skip: a slow tick does not stack (projector poll never piles up)"
  );

  // 4 — SSE hub fan-out: one publish reaches every subscriber on the key; keys isolated; unsub cleans
  const hub = new SseHub();
  const a = hub.subscribe("user1")[Symbol.asyncIterator]();
  const b = hub.subscribe("user1")[Symbol.asyncIterator]();
  const c = hub.subscribe("user2")[Symbol.asyncIterator]();
  hub.publish("user1", { event: "job.updated", data: { id: 7 } });
  assert.deepEqual(
    (await a.next()).value,
    { event: "job.updated", data: { id: 7 } },
    "sub A got it"
  );
  assert.deepEqual(
    (await b.next()).value,
    { event: "job.updated", data: { id: 7 } },
    "sub B got the same"
  );
  assert.equal(
    hub.subscriberCount("user1"),
    2,
    "two sessions of the same user"
  );
  hub.publish("user2", { event: "job.created", data: { id: 9 } });
  assert.deepEqual(
    (await c.next()).value,
    { event: "job.created", data: { id: 9 } },
    "user2 isolated"
  );
  await a.return(); // client disconnect
  assert.equal(
    hub.subscriberCount("user1"),
    1,
    "disconnect unsubscribed A — no leak"
  );
  ok(
    4,
    "SSE fan-out: one write → all of a user's sessions; keys isolated; disconnect unsubscribes"
  );

  console.log(
    `\n  SPIKE ${pass}/4 GREEN — differentiator holds: scheduler tick = CLS-scoped UoW; SSE hub fans out.\n`
  );
}

main().catch((e) => {
  console.error(`\n  ✗ SPIKE FAILED: ${e.message}\n`);
  process.exit(1);
});
