// @spinejs/throttle/testing — the store contract kit (FR-20): reusable assertions pinning the AD-4
// store semantics, so any implementation (Redis, counter-optimized) validates against identical
// assertions without copying tests. Dependency-free: cases throw plain Errors on violation and are
// registered through whatever test API the consumer passes in (vitest, jest, node:test…).
import type {
  Clock,
  ConsumeResult,
  StorePolicy,
  ThrottleStore,
} from "./throttle.types";

/** Deterministic test clock (NFR-5): time only moves when the test says so. */
export class FakeClock implements Clock {
  private t = 0;
  now = (): number => this.t;
  tick(ms: number): void {
    this.t += ms;
  }
}

/** Builds the store under test. Called once per contract case with that case's fake clock. */
export type ThrottleStoreFactory = (clock: Clock) => ThrottleStore;

/** One pinned semantic of the store port. `run` throws (with a diagnostic) when the store violates it. */
export interface StoreContractCase {
  name: string;
  run(makeStore: ThrottleStoreFactory): Promise<void>;
}

/** Minimal slice of a test framework the kit registers through (structural — vitest/jest/node:test fit). */
export interface StoreContractTestApi {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => unknown): void;
}

const policy = (overrides: Partial<StorePolicy> = {}): StorePolicy => ({
  id: "contract",
  limit: 3,
  windowMs: 1000,
  ...overrides,
});

function expectEqual(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`Store contract violated — ${what}: got ${a}, want ${b}`);
  }
}

/** Runs a case body against a fresh store + clock, always disposing the store. */
async function withStore(
  makeStore: ThrottleStoreFactory,
  body: (store: ThrottleStore, clock: FakeClock) => Promise<void>
): Promise<void> {
  const clock = new FakeClock();
  const store = makeStore(clock);
  try {
    await body(store, clock);
  } finally {
    store.dispose?.();
  }
}

/**
 * The pinned store semantics (AD-4/FR-15/FR-16), each independently runnable. Every case drives the
 * store through the injected {@link FakeClock}, so runs are deterministic (NFR-5).
 */
export const throttleStoreContract: readonly StoreContractCase[] = [
  {
    name: "consume is atomic: concurrent calls at the limit accept exactly `limit` hits",
    run: (makeStore) =>
      withStore(makeStore, async (store) => {
        const p = policy({ limit: 5 });
        // 10 in-flight calls with no interleaving point granted by the caller: exactly five may
        // accept (totalHits 1…5) and five must reject (totalHits = limit). A read-then-write race
        // shows up as duplicated low counts.
        const results = await Promise.all(
          Array.from({ length: 10 }, () => store.consume("k", p))
        );
        const counts = results.map((r) => r.totalHits).sort((x, y) => x - y);
        expectEqual(counts, [1, 2, 3, 4, 5, 5, 5, 5, 5, 5], "atomicity");
      }),
  },
  {
    name: "resetMs is relative: it shrinks as the clock advances toward the oldest slot's expiry",
    run: (makeStore) =>
      withStore(makeStore, async (store, clock) => {
        const first = await store.consume("k", policy());
        expectEqual(first.resetMs, 1000, "resetMs of the first hit");
        clock.tick(300);
        const second = await store.consume("k", policy());
        expectEqual(
          second.resetMs,
          700,
          "resetMs relative to now (oldest hit frees 700ms later)"
        );
      }),
  },
  {
    name: "rejects at limit with totalHits = limit and the exact time until the oldest slot frees",
    run: (makeStore) =>
      withStore(makeStore, async (store, clock) => {
        for (let i = 0; i < 3; i++) await store.consume("k", policy());
        clock.tick(250);
        const rejected = await store.consume("k", policy());
        expectEqual(
          rejected,
          { totalHits: 3, resetMs: 750 } satisfies ConsumeResult,
          "post-decision reject state"
        );
      }),
  },
  {
    name: "consumption is unconditional: a rejection never refunds an accepted hit",
    run: (makeStore) =>
      withStore(makeStore, async (store, clock) => {
        const p = policy({ limit: 2 });
        await store.consume("k", p);
        await store.consume("k", p); // full at t=0
        // Two in-window probes. A refunding store frees a slot on the first rejection and
        // silently ACCEPTS the second probe (indistinguishable here: both report totalHits =
        // limit) — but that smuggled-in hit becomes visible after the legitimate hits expire.
        clock.tick(100);
        expectEqual(
          (await store.consume("k", p)).totalHits,
          2,
          "rejection at t=100"
        );
        clock.tick(100);
        expectEqual(
          (await store.consume("k", p)).totalHits,
          2,
          "rejection at t=200"
        );
        clock.tick(800); // t=1000: both t=0 hits expired — and ONLY those may ever have counted
        expectEqual(
          await store.consume("k", p),
          { totalHits: 1, resetMs: 1000 } satisfies ConsumeResult,
          "no refund: only the originally accepted hits occupied the window"
        );
      }),
  },
  {
    name: "the log holds accepted hits only: a window of rejections does not extend the block",
    run: (makeStore) =>
      withStore(makeStore, async (store, clock) => {
        for (let i = 0; i < 3; i++) await store.consume("k", policy());
        // Hammer with rejections across the whole window.
        for (let i = 0; i < 9; i++) {
          clock.tick(100); // t = 100 … 900
          expectEqual(
            (await store.consume("k", policy())).totalHits,
            3,
            `rejection at t=${clock.now()}`
          );
        }
        clock.tick(100); // t = 1000: the t=0 hits free exactly at oldest + windowMs
        expectEqual(
          (await store.consume("k", policy())).totalHits,
          1,
          "acceptance right after expiry (rejections must not have grown the log)"
        );
      }),
  },
  {
    name: "reclamation is observable: an idle key restarts a fresh window after expiry",
    run: (makeStore) =>
      withStore(makeStore, async (store, clock) => {
        for (let i = 0; i < 3; i++) await store.consume("k", policy());
        clock.tick(5000); // idle far past the window
        expectEqual(
          await store.consume("k", policy()),
          { totalHits: 1, resetMs: 1000 } satisfies ConsumeResult,
          "fresh window after idle expiry"
        );
      }),
  },
];

/**
 * Registers every contract case against your store through your test framework:
 *
 *   // my-store.spec.ts
 *   import { describe, it } from "vitest";
 *   import { registerThrottleStoreContract } from "@spinejs/throttle/testing";
 *
 *   registerThrottleStoreContract(
 *     (clock) => new MyRedisThrottleStore({ clock }),
 *     { describe, it }
 *   );
 */
export function registerThrottleStoreContract(
  makeStore: ThrottleStoreFactory,
  api: StoreContractTestApi
): void {
  api.describe(
    "ThrottleStore contract (AD-4, @spinejs/throttle/testing)",
    () => {
      for (const contractCase of throttleStoreContract) {
        api.it(contractCase.name, () => contractCase.run(makeStore));
      }
    }
  );
}
