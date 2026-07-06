import type {
  Clock,
  ConsumeResult,
  StorePolicy,
  ThrottleStore,
} from "./throttle.types";

/**
 * Default {@link Clock}: monotonic milliseconds (`performance.now()`), never wall-clock-adjusted —
 * a system clock jump can neither refund nor extend a window (FR-21).
 */
export const monotonicClock: Clock = {
  now: () => performance.now(),
};

export interface InMemoryThrottleStoreOptions {
  /** Injectable time source (FR-21). Defaults to {@link monotonicClock}. */
  clock?: Clock;
  /**
   * Interval (ms) of the periodic reclamation sweep dropping fully-expired keys. The timer is
   * unref'd (never keeps the process alive) and released by `dispose()`. `0` disables the sweep
   * (lazy purge on access still applies). Default 60 000.
   */
  sweepIntervalMs?: number;
}

/**
 * One key's in-window state: the **accepted** hit timestamps (ascending, ≤ `limit` entries — a
 * rejected request never grows the log, so per-key memory is O(limit) by construction, AD-4) plus
 * the window length last used for this key, kept so the sweep can decide expiry without a policy.
 */
interface KeyLog {
  hits: number[];
  windowMs: number;
}

/** One policy's isolated key space (AD-5). Map insertion order doubles as the LRU order. */
interface PolicySpace {
  keys: Map<string, KeyLog>;
}

/**
 * Built-in store: **exact sliding-window log** behind the pinned `consume` port (AD-4, FR-16).
 *
 * Semantics per call (atomic — the body is synchronous, so no interleaving on the JS thread):
 * - under limit → the hit is appended; `totalHits` = the new in-window count;
 * - at limit → reject: `totalHits = limit`, `resetMs` = exact time until the oldest slot frees
 *   (`oldest + windowMs − now`), and the log does not grow;
 * - `resetMs` is always relative; `remaining` is always derived by callers, never stored.
 *
 * Expired entries are lazily purged on access; a periodic unref'd sweep reclaims keys that are
 * never touched again. Each policy id owns an isolated key space.
 */
export class InMemoryThrottleStore implements ThrottleStore {
  private readonly spaces = new Map<string, PolicySpace>();
  private readonly clock: Clock;
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(options: InMemoryThrottleStoreOptions = {}) {
    this.clock = options.clock ?? monotonicClock;
    const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;
    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  async consume(key: string, policy: StorePolicy): Promise<ConsumeResult> {
    const now = this.clock.now();
    let space = this.spaces.get(policy.id);
    if (!space) {
      space = { keys: new Map() };
      this.spaces.set(policy.id, space);
    }

    let log = space.keys.get(key);
    if (!log) {
      log = { hits: [], windowMs: policy.windowMs };
      space.keys.set(key, log);
    } else {
      log.windowMs = policy.windowMs;
    }

    // Lazy purge: drop hits that slid out of the window.
    const cutoff = now - policy.windowMs;
    while (log.hits.length > 0 && log.hits[0] <= cutoff) log.hits.shift();

    if (log.hits.length >= policy.limit) {
      // Reject — the log holds accepted hits only, so it does not grow.
      return {
        totalHits: policy.limit,
        resetMs: log.hits[0] + policy.windowMs - now,
      };
    }

    log.hits.push(now);
    return {
      totalHits: log.hits.length,
      resetMs: log.hits[0] + policy.windowMs - now,
    };
  }

  /** Releases the sweep timer and drops all state. Idempotent. */
  dispose(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.spaces.clear();
  }

  /** Reclaims keys whose every hit expired (they would otherwise linger until next access). */
  private sweep(): void {
    const now = this.clock.now();
    for (const space of this.spaces.values()) {
      for (const [key, log] of space.keys) {
        const cutoff = now - log.windowMs;
        while (log.hits.length > 0 && log.hits[0] <= cutoff) log.hits.shift();
        if (log.hits.length === 0) space.keys.delete(key);
      }
    }
  }
}
