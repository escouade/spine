import { describe, expect, it, vi } from "vitest";
import { ClsService } from "@spinejs/cls";
import type { Logger } from "@spinejs/core";
import { SchedulerRegistry } from "./scheduler.registry";
import type { TickAround } from "./scheduler.options";

const silentLog = (): Logger => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
});

const nextTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// A per-tick UnitOfWork that mirrors the MikroORM forked-EM contract (identity map + flush on
// commit + discard on rollback). The ORM engine itself is spiked elsewhere; here we only exercise
// the scheduler composition, which is engine-agnostic.
const EM = "test:em";
type Row = Record<string, unknown>;

class Uow {
  readonly identity = new Map<string, Row>();
  constructor(private readonly store: Map<string, Row>) {}
  find(id: string): Row | undefined {
    const persisted = this.store.get(id);
    if (!this.identity.has(id) && persisted)
      this.identity.set(id, { ...persisted });
    return this.identity.get(id);
  }
  create(id: string, data: Row): Row {
    const row = { id, ...data };
    this.identity.set(id, row);
    return row;
  }
  commit(): void {
    for (const [id, row] of this.identity) this.store.set(id, { ...row });
  }
  rollback(): void {
    this.identity.clear();
  }
}

const withUow =
  (cls: ClsService, store: Map<string, Row>): TickAround =>
  (next) =>
  async () => {
    const uow = new Uow(store);
    cls.set(EM, uow);
    try {
      await next();
      uow.commit();
    } catch (e) {
      uow.rollback();
      throw e;
    }
  };

describe("SchedulerRegistry", () => {
  it("runs a tick in a fresh CLS scope; the around-hook UnitOfWork commits without an explicit save", async () => {
    const cls = new ClsService();
    const store = new Map<string, Row>();
    const reg = new SchedulerRegistry(cls, silentLog());

    reg.register(
      {
        name: "projector",
        everyMs: 1000,
        around: [withUow(cls, store)],
        run: () => {
          const uow = cls.get(EM) as Uow;
          const cursor = uow.find("cursor") ?? uow.create("cursor", { at: 0 });
          cursor.at = (cursor.at as number) + 1; // dirty-tracked; flushed at commit — no .save()
          uow.create(`job:${cursor.at}`, { status: "pending" });
        },
      },
      []
    );

    expect(cls.active).toBe(false); // no scope outside a tick
    await reg.runNow("projector");
    expect(store.get("cursor")).toEqual({ id: "cursor", at: 1 });
    expect(store.get("job:1")).toEqual({ id: "job:1", status: "pending" });

    await reg.runNow("projector"); // second tick = second fresh UoW, sees committed state
    expect(store.get("cursor")).toEqual({ id: "cursor", at: 2 });
  });

  it("rolls back the tick's UnitOfWork on failure — no partial writes escape", async () => {
    const cls = new ClsService();
    const store = new Map<string, Row>([["cursor", { id: "cursor", at: 5 }]]);
    const log = silentLog();
    const reg = new SchedulerRegistry(cls, log);

    reg.register(
      {
        name: "boom",
        everyMs: 1000,
        around: [withUow(cls, store)],
        run: () => {
          (cls.get(EM) as Uow).create("job:x", { status: "pending" });
          throw new Error("tick failed");
        },
      },
      []
    );

    await reg.runNow("boom"); // caught + logged, never rejects
    expect(store.has("job:x")).toBe(false);
    expect(store.get("cursor")).toEqual({ id: "cursor", at: 5 });
    expect(log.error).toHaveBeenCalledOnce();
  });

  it("overlap=skip (default): a tick firing while one is running is dropped", async () => {
    const cls = new ClsService();
    let entered = 0;
    let release: () => void = () => {};
    const reg = new SchedulerRegistry(cls, silentLog());

    reg.register(
      {
        name: "slow",
        everyMs: 1000,
        run: () => {
          entered += 1;
          return new Promise<void>((r) => {
            release = r;
          });
        },
      },
      []
    );

    const first = reg.runNow("slow"); // starts, running = true, pending
    await reg.runNow("slow"); // fires again → skipped, resolves immediately
    expect(entered).toBe(1);

    release();
    await first;
    expect(reg.isRunning("slow")).toBe(false);
  });

  it("overlap=queue: overlapping ticks serialize, each running once in order", async () => {
    const cls = new ClsService();
    const order: number[] = [];
    let n = 0;
    const reg = new SchedulerRegistry(cls, silentLog());

    reg.register(
      {
        name: "q",
        everyMs: 1000,
        overlap: "queue",
        run: async () => {
          const me = ++n;
          await nextTick();
          order.push(me);
        },
      },
      []
    );

    await Promise.all([reg.runNow("q"), reg.runNow("q"), reg.runNow("q")]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("start() arms timers; stop() clears them and drains the in-flight tick", async () => {
    const cls = new ClsService();
    let ticks = 0;
    let release: () => void = () => {};
    const reg = new SchedulerRegistry(cls, silentLog());

    reg.register(
      {
        name: "t",
        everyMs: 5,
        run: () => {
          ticks += 1;
          return new Promise<void>((r) => {
            release = r;
          });
        },
      },
      []
    );

    reg.start();
    await vi.waitUntil(() => ticks === 1, { timeout: 1000 });

    const stopping = reg.stop(); // clears the timer, then awaits the in-flight tick
    release();
    await stopping;

    const after = ticks;
    await nextTick();
    await nextTick();
    expect(ticks).toBe(after); // no further ticks after stop()
  });

  it("rejects duplicate task names", () => {
    const cls = new ClsService();
    const reg = new SchedulerRegistry(cls, silentLog());
    const task = { name: "dupe", everyMs: 1000, run: () => {} };
    reg.register(task, []);
    expect(() => reg.register(task, [])).toThrow(/duplicate task name/);
  });
});
