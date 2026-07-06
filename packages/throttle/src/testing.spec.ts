import { describe, expect, it } from "vitest";
import { InMemoryThrottleStore } from "./memory-store";
import {
  registerThrottleStoreContract,
  throttleStoreContract,
} from "./testing";
import type {
  Clock,
  ConsumeResult,
  StorePolicy,
  ThrottleStore,
} from "./throttle.types";

// AC 1 (Story 1.6): the kit passes against the built-in memory store — every pinned semantic
// (atomicity, relative resetMs, accepted-hits-only growth, no refund, reclamation), fake clock.
registerThrottleStoreContract(
  (clock) => new InMemoryThrottleStore({ clock, sweepIntervalMs: 0 }),
  { describe, it }
);

/**
 * Deliberately broken store double: refunds the oldest accepted hit on every rejection. Everything
 * else mirrors a correct sliding log — only the no-refund semantic is violated.
 */
class RefundingStore implements ThrottleStore {
  private readonly logs = new Map<string, number[]>();
  constructor(private readonly clock: Clock) {}

  async consume(key: string, policy: StorePolicy): Promise<ConsumeResult> {
    const now = this.clock.now();
    let log = this.logs.get(key);
    if (!log) {
      log = [];
      this.logs.set(key, log);
    }
    const cutoff = now - policy.windowMs;
    while (log.length > 0 && log[0] <= cutoff) log.shift();

    if (log.length >= policy.limit) {
      log.shift(); // THE BUG: a rejection refunds the oldest accepted hit.
      return {
        totalHits: policy.limit,
        resetMs: log.length ? log[0] + policy.windowMs - now : policy.windowMs,
      };
    }
    log.push(now);
    return { totalHits: log.length, resetMs: log[0] + policy.windowMs - now };
  }
}

describe("contract kit discrimination (Story 1.6)", () => {
  const caseByName = (fragment: string) => {
    const found = throttleStoreContract.find((c) => c.name.includes(fragment));
    if (!found) throw new Error(`No contract case matching "${fragment}"`);
    return found;
  };

  it("fails the no-refund case against a store that refunds on reject", async () => {
    const noRefund = caseByName("never refunds");
    await expect(
      noRefund.run((clock) => new RefundingStore(clock))
    ).rejects.toThrow(/no refund/);
  });

  it("still passes the broken double on unrelated cases (the failure is targeted)", async () => {
    // The refund bug does not touch relative resetMs — that case must not produce a false alarm.
    const resetMs = caseByName("resetMs is relative");
    await expect(
      resetMs.run((clock) => new RefundingStore(clock))
    ).resolves.toBeUndefined();
  });

  it("exposes every pinned semantic as an independently runnable case", () => {
    expect(throttleStoreContract.map((c) => c.name)).toEqual([
      expect.stringContaining("atomic"),
      expect.stringContaining("resetMs is relative"),
      expect.stringContaining("rejects at limit"),
      expect.stringContaining("never refunds"),
      expect.stringContaining("accepted hits only"),
      expect.stringContaining("reclamation"),
    ]);
  });
});
