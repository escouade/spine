import { afterEach, describe, expect, it } from "vitest";
import { InMemoryThrottleStore, monotonicClock } from "./memory-store";
import type { Clock, ConsumeResult, StorePolicy } from "./throttle.types";

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
      accepted: true,
      totalHits: 1,
      resetMs: 1000,
    });
    clock.tick(100);
    expect(await store.consume("k", policy())).toEqual({
      accepted: true,
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
    expect(rejected).toEqual({ accepted: false, totalHits: 3, resetMs: 500 }); // oldest (t=0) + 1000 − 500
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
      accepted: true,
      totalHits: 1, // the 19 rejections above never grew the log
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
    expect(await store.consume("k", policy())).toMatchObject({
      accepted: true,
      totalHits: 3, // accepted, full again
    });
    expect(await store.consume("k", policy())).toMatchObject({
      accepted: false,
      totalHits: 3, // rejected: still full
    });
  });

  it("purges expired entries lazily on access", async () => {
    const clock = new FakeClock();
    const store = makeStore(clock);
    for (let i = 0; i < 3; i++) await store.consume("k", policy());

    clock.tick(1500); // whole window slid past
    expect(await store.consume("k", policy())).toEqual({
      accepted: true,
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
      accepted: true,
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

describe("per-policy bounds, LRU and introspection (AD-5, Story 1.5)", () => {
  const bounded = (id: string, maxKeys: number): StorePolicy =>
    policy({ id, maxKeys });

  it("evicts the least-recently-used key beyond the policy's max-keys bound", async () => {
    const clock = new FakeClock();
    const store = makeStore(clock);
    const p = bounded("A", 2);

    await store.consume("a", p);
    await store.consume("b", p);
    await store.consume("a", p); // touch: 'a' becomes most-recent, 'b' is now LRU
    await store.consume("c", p); // over bound → evicts 'b', not 'a'

    expect(store.stats().A).toEqual({ size: 2, evictions: 1 });
    // 'a' kept its counter (2 hits + the next one = at limit 3)…
    expect((await store.consume("a", p)).totalHits).toBe(3);
    // …while 'b' restarts a fresh window (its state was evicted).
    expect((await store.consume("b", p)).totalHits).toBe(1);
    expect(store.stats().A.evictions).toBe(2); // 'b' re-entering evicted the LRU again
  });

  it("never evicts across policy spaces: flooding A leaves B's counters untouched", async () => {
    const clock = new FakeClock();
    const store = makeStore(clock);
    const a = bounded("A", 3);
    const b = bounded("B", 3);

    // Policy B tracks a victim key up to its limit.
    for (let i = 0; i < 3; i++) await store.consume("victim", b);
    expect((await store.consume("victim", b)).totalHits).toBe(3); // at limit

    // Flood policy A's space far past its bound.
    for (let i = 0; i < 50; i++) await store.consume(`attacker-${i}`, a);

    // Only A evicted; B's counter survived — the victim is STILL at limit (no reset-by-flood).
    expect(store.stats().A.size).toBe(3);
    expect(store.stats().A.evictions).toBe(47);
    expect(store.stats().B).toEqual({ size: 1, evictions: 0 });
    expect((await store.consume("victim", b)).totalHits).toBe(3); // still rejected
  });

  it("reports { size, evictions } per policy space at any time", async () => {
    const clock = new FakeClock();
    const store = makeStore(clock);
    expect(store.stats()).toEqual({});

    await store.consume("x", policy({ id: "P1" }));
    await store.consume("y", policy({ id: "P1" }));
    await store.consume("x", policy({ id: "P2" }));

    expect(store.stats()).toEqual({
      P1: { size: 2, evictions: 0 },
      P2: { size: 1, evictions: 0 },
    });
  });

  it("falls back to the store-level maxKeysPerPolicy default", async () => {
    const clock = new FakeClock();
    const store = new InMemoryThrottleStore({ clock, maxKeysPerPolicy: 1 });
    stores.push(store);

    await store.consume("a", policy());
    await store.consume("b", policy());
    expect(store.stats().p).toEqual({ size: 1, evictions: 1 });
  });

  it("rejects a non-positive/non-integer maxKeysPerPolicy at construction (would disable the bound)", () => {
    expect(() => new InMemoryThrottleStore({ maxKeysPerPolicy: 0 })).toThrow(
      /positive integer/
    );
    expect(
      () => new InMemoryThrottleStore({ maxKeysPerPolicy: Number.NaN })
    ).toThrow(/positive integer/);
  });
});

describe("store robustness (review PR #36)", () => {
  it("throws on consume after dispose — no silent state resurrection without a sweep timer", async () => {
    const store = new InMemoryThrottleStore({
      clock: new FakeClock(),
      sweepIntervalMs: 0,
    });
    await store.consume("k", policy());
    store.dispose();
    await expect(store.consume("k", policy())).rejects.toThrow(/after dispose/);
  });

  it("clamps a non-monotonic custom clock so the ascending hit log never rewinds", async () => {
    let t = 1000;
    const clock: Clock = { now: () => t };
    const store = new InMemoryThrottleStore({ clock, sweepIntervalMs: 0 });
    stores.push(store);

    expect(await store.consume("k", policy())).toEqual({
      accepted: true,
      totalHits: 1,
      resetMs: 1000,
    });
    t = 500; // clock rewinds — the store must clamp `now` to the last observed 1000
    const second = await store.consume("k", policy());
    expect(second.totalHits).toBe(2); // appended in order, not before the first hit
    expect(second.resetMs).toBe(1000); // oldest(1000) + windowMs(1000) − now(clamped 1000)
  });
});
