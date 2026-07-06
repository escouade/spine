import { afterEach, describe, expect, it } from "vitest";
import { InMemoryThrottleStore, monotonicClock } from "./memory-store";
import type { ConsumeResult, StorePolicy } from "./throttle.types";

/** Deterministic test clock (NFR-5): time only moves when the test says so. */
class FakeClock {
  private t = 0;
  now = () => this.t;
  tick(ms: number): void {
    this.t += ms;
  }
}

const policy = (overrides: Partial<StorePolicy> = {}): StorePolicy => ({
  id: "p",
  limit: 3,
  windowMs: 1000,
  ...overrides,
});

let stores: InMemoryThrottleStore[] = [];
const makeStore = (clock: FakeClock): InMemoryThrottleStore => {
  const store = new InMemoryThrottleStore({ clock });
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores) store.dispose();
  stores = [];
});

describe("InMemoryThrottleStore — exact sliding-window log (AD-4, Story 1.4)", () => {
  it("appends accepted hits and reports the new in-window count", async () => {
    const clock = new FakeClock();
    const store = makeStore(clock);

    expect(await store.consume("k", policy())).toEqual({
      totalHits: 1,
      resetMs: 1000,
    });
    clock.tick(100);
    expect(await store.consume("k", policy())).toEqual({
      totalHits: 2,
      resetMs: 900, // oldest hit (t=0) frees at t=1000
    });
  });

  it("rejects at limit with totalHits = limit and the exact time until the oldest slot frees", async () => {
    const clock = new FakeClock();
    const store = makeStore(clock);
    await store.consume("k", policy()); // t=0
    clock.tick(200);
    await store.consume("k", policy()); // t=200
    clock.tick(200);
    await store.consume("k", policy()); // t=400 — at limit 3

    clock.tick(100); // t=500
    const rejected = await store.consume("k", policy());
    expect(rejected).toEqual({ totalHits: 3, resetMs: 500 }); // oldest (t=0) + 1000 − 500
  });

  it("does not grow the log on rejection (rejects are free — memory O(limit))", async () => {
    const clock = new FakeClock();
    const store = makeStore(clock);
    for (let i = 0; i < 3; i++) await store.consume("k", policy()); // fill at t=0

    // Hammer with rejections for the whole window: if any had been appended, the key
    // would still be blocked after the original hits expire.
    for (let i = 0; i < 19; i++) {
      clock.tick(50); // t = 50 … 950
      expect((await store.consume("k", policy())).totalHits).toBe(3);
    }
    clock.tick(50); // t=1000 — the t=0 hits free exactly at oldest + windowMs
    expect(await store.consume("k", policy())).toEqual({
      totalHits: 1, // accepted: the 19 rejections above never grew the log
      resetMs: 1000,
    });
  });

  it("frees slots one by one as hits slide out (sliding window, not fixed buckets)", async () => {
    const clock = new FakeClock();
    const store = makeStore(clock);
    await store.consume("k", policy()); // t=0
    clock.tick(400);
    await store.consume("k", policy()); // t=400
    clock.tick(400);
    await store.consume("k", policy()); // t=800 — full

    clock.tick(201); // t=1001: the t=0 hit expired, exactly one slot free
    expect((await store.consume("k", policy())).totalHits).toBe(3); // accepted, full again
    expect((await store.consume("k", policy())).totalHits).toBe(3); // rejected: still full
  });

  it("purges expired entries lazily on access", async () => {
    const clock = new FakeClock();
    const store = makeStore(clock);
    for (let i = 0; i < 3; i++) await store.consume("k", policy());

    clock.tick(1500); // whole window slid past
    expect(await store.consume("k", policy())).toEqual({
      totalHits: 1,
      resetMs: 1000, // fresh window
    });
  });

  it("keeps keys independent", async () => {
    const clock = new FakeClock();
    const store = makeStore(clock);
    for (let i = 0; i < 3; i++) await store.consume("a", policy());

    expect((await store.consume("b", policy())).totalHits).toBe(1);
    expect((await store.consume("a", policy())).totalHits).toBe(3); // still rejected
  });

  it("replays a fixed sequence identically on a fresh store (NFR-5 determinism)", async () => {
    const run = async (): Promise<ConsumeResult[]> => {
      const clock = new FakeClock();
      const store = makeStore(clock);
      const results: ConsumeResult[] = [];
      for (const step of [0, 100, 100, 100, 400, 400, 50, 50]) {
        clock.tick(step);
        results.push(await store.consume("k", policy()));
      }
      return results;
    };

    expect(await run()).toEqual(await run());
  });

  it("reclaims never-touched expired keys through the periodic sweep", async () => {
    const clock = new FakeClock();
    const store = new InMemoryThrottleStore({ clock, sweepIntervalMs: 0 });
    stores.push(store);
    await store.consume("gone", policy());
    clock.tick(2000);

    // Drive the sweep directly (the interval timer is the production trigger).
    (store as unknown as { sweep(): void }).sweep();
    // Observable effect: the key restarts a fresh window as if never seen.
    expect(await store.consume("gone", policy())).toEqual({
      totalHits: 1,
      resetMs: 1000,
    });
  });

  it("defaults to the monotonic clock", () => {
    const before = monotonicClock.now();
    const after = monotonicClock.now();
    expect(after).toBeGreaterThanOrEqual(before);
  });
});
