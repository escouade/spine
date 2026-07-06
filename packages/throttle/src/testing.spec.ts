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
        accepted: false,
        totalHits: policy.limit,
        resetMs: log.length ? log[0] + policy.windowMs - now : policy.windowMs,
      };
    }
    log.push(now);
    return {
      accepted: true,
      totalHits: log.length,
      resetMs: log[0] + policy.windowMs - now,
    };
  }
}

/** A correct sliding-log store that returns its `ConsumeResult` fields in a DIFFERENT key order. */
class ReorderingStore implements ThrottleStore {
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
      // Correct values — only the property order differs from the reference store.
      return {
        resetMs: log[0] + policy.windowMs - now,
        totalHits: policy.limit,
        accepted: false,
      };
    }
    log.push(now);
    return {
      resetMs: log[0] + policy.windowMs - now,
      totalHits: log.length,
      accepted: true,
    };
  }
}

/**
 * Non-atomic store: reads the under-limit decision, then YIELDS before appending. Concurrent calls
 * all pass the gate before any of them writes — a read-then-write race that admits more than `limit`.
 */
class NonAtomicStore implements ThrottleStore {
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
    const underLimit = log.length < policy.limit; // decision read…
    await Promise.resolve(); // …then a yield: every concurrent call decides before any appends
    if (!underLimit) {
      return {
        accepted: false,
        totalHits: policy.limit,
        resetMs: log[0] + policy.windowMs - now,
      };
    }
    log.push(now);
    return {
      accepted: true,
      totalHits: log.length,
      resetMs: log[0] + policy.windowMs - now,
    };
  }
}

/** Reports `resetMs` as the absolute window length, never decremented by elapsed time (not relative). */
class AbsoluteResetStore implements ThrottleStore {
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
      return {
        accepted: false,
        totalHits: policy.limit,
        resetMs: policy.windowMs, // THE BUG: absolute, not `oldest + windowMs − now`.
      };
    }
    log.push(now);
    return {
      accepted: true,
      totalHits: log.length,
      resetMs: policy.windowMs, // THE BUG.
    };
  }
}

/** Off-by-one at the boundary: rejects only when STRICTLY over the limit, so it admits `limit + 1`. */
class OverLimitStore implements ThrottleStore {
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
    if (log.length > policy.limit) {
      // THE BUG: `>` instead of `>=` — the `limit`-th call still accepts.
      return {
        accepted: false,
        totalHits: policy.limit,
        resetMs: log[0] + policy.windowMs - now,
      };
    }
    log.push(now);
    return {
      accepted: true,
      totalHits: log.length,
      resetMs: log[0] + policy.windowMs - now,
    };
  }
}

/** Grows the log on rejection too, so a window of rejected attempts extends the block past expiry. */
class GrowOnRejectStore implements ThrottleStore {
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
      log.push(now); // THE BUG: a rejected attempt is appended, extending the window.
      return {
        accepted: false,
        totalHits: policy.limit,
        resetMs: log[0] + policy.windowMs - now,
      };
    }
    log.push(now);
    return {
      accepted: true,
      totalHits: log.length,
      resetMs: log[0] + policy.windowMs - now,
    };
  }
}

/** Never reclaims: expired hits are never purged, so an idle key never restarts a fresh window. */
class NoReclaimStore implements ThrottleStore {
  private readonly logs = new Map<string, number[]>();
  constructor(private readonly clock: Clock) {}

  async consume(key: string, policy: StorePolicy): Promise<ConsumeResult> {
    const now = this.clock.now();
    let log = this.logs.get(key);
    if (!log) {
      log = [];
      this.logs.set(key, log);
    }
    // THE BUG: no lazy purge of expired hits.
    if (log.length >= policy.limit) {
      return {
        accepted: false,
        totalHits: policy.limit,
        resetMs: log[0] + policy.windowMs - now,
      };
    }
    log.push(now);
    return {
      accepted: true,
      totalHits: log.length,
      resetMs: log[0] + policy.windowMs - now,
    };
  }
}

describe("contract kit discrimination (Story 1.6)", () => {
  const caseByName = (fragment: string) => {
    const found = throttleStoreContract.find((c) => c.name.includes(fragment));
    if (!found) throw new Error(`No contract case matching "${fragment}"`);
    return found;
  };

  it("passes a conforming store whose ConsumeResult keys are in a different order (semantic compare)", async () => {
    // A JSON.stringify compare would flag this as a false violation; the semantic compare must not.
    const rejects = caseByName("rejects at limit");
    await expect(
      rejects.run((clock) => new ReorderingStore(clock))
    ).resolves.toBeUndefined();
  });

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

  // Each remaining pinned semantic gets a store broken in exactly the way that semantic guards — so a
  // silently-vacuous assertion (one that never actually discriminates) would surface as a green case here.

  it("fails the atomicity case against a non-atomic (read-then-write racy) store", async () => {
    const atomic = caseByName("atomic");
    await expect(
      atomic.run((clock) => new NonAtomicStore(clock))
    ).rejects.toThrow(/atomicity/);
  });

  it("fails the relative-resetMs case against a store reporting the absolute window length", async () => {
    const relative = caseByName("resetMs is relative");
    await expect(
      relative.run((clock) => new AbsoluteResetStore(clock))
    ).rejects.toThrow(/resetMs relative to now/);
  });

  it("fails the rejects-at-limit case against an off-by-one store that admits limit+1", async () => {
    const rejects = caseByName("rejects at limit");
    await expect(
      rejects.run((clock) => new OverLimitStore(clock))
    ).rejects.toThrow(/post-decision reject state/);
  });

  it("fails the accepted-hits-only case against a store that grows the log on rejection", async () => {
    const acceptedOnly = caseByName("accepted hits only");
    await expect(
      acceptedOnly.run((clock) => new GrowOnRejectStore(clock))
    ).rejects.toThrow(/acceptance right after expiry/);
  });

  it("fails the reclamation case against a store that never reclaims expired keys", async () => {
    const reclamation = caseByName("reclamation");
    await expect(
      reclamation.run((clock) => new NoReclaimStore(clock))
    ).rejects.toThrow(/fresh window after idle/);
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
