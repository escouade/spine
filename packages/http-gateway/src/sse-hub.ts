/**
 * A server-sent event. `data` is JSON-serialized when it is not already a string; `event`/`id`/`retry`
 * map to the SSE `event:`/`id:`/`retry:` fields.
 */
export interface SseEvent {
  data: unknown;
  event?: string;
  id?: string;
  retry?: number;
}

export interface SseHubOptions {
  /**
   * Max events buffered for one slow subscriber before the oldest is dropped. SSE is a best-effort
   * wakeup (clients re-sync on reconnect), so bounded + drop-oldest beats unbounded memory growth.
   * Default 1000.
   */
  maxQueuePerSubscriber?: number;
}

/**
 * In-memory fan-out for Server-Sent Events, keyed by a subscription key (e.g. a userId). One
 * `publish(key, event)` reaches **every** open subscriber on that key — the fan-out an SSE endpoint
 * needs to push one server-side change to all of a user's sessions. Transport-agnostic: `subscribe`
 * returns a plain `AsyncIterable`, which the HTTP transport pumps to the wire.
 *
 * ```ts
 * const hub = new SseHub<string>();               // keyed by userId
 * // in a controller:  stream = sse("/jobs/stream", {}, (_i, ctx) => hub.subscribe(ctx.user.id));
 * // on every job write (e.g. from LISTEN/NOTIFY):
 * hub.publish(userId, { event: "job.updated", data: state });
 * ```
 */
export class SseHub<K = string> {
  private readonly subscribers = new Map<K, Set<SseSubscriber>>();
  private readonly maxQueue: number;

  constructor(options: SseHubOptions = {}) {
    this.maxQueue = options.maxQueuePerSubscriber ?? 1000;
  }

  /** Open a stream for `key`. Iterate with `for await`; breaking/returning unsubscribes. */
  subscribe(key: K): AsyncIterable<SseEvent> {
    let set = this.subscribers.get(key);
    if (!set) {
      set = new Set<SseSubscriber>();
      this.subscribers.set(key, set);
    }
    const subscriber = new SseSubscriber(this.maxQueue, () => {
      set.delete(subscriber);
      if (set.size === 0) this.subscribers.delete(key);
    });
    set.add(subscriber);
    return subscriber;
  }

  /** Push an event to every open subscriber on `key`. No-op when there are none. */
  publish(key: K, event: SseEvent): void {
    const set = this.subscribers.get(key);
    if (!set) return;
    for (const subscriber of set) subscriber.push(event);
  }

  /** Live subscriber count for `key` (introspection / tests). */
  subscriberCount(key: K): number {
    return this.subscribers.get(key)?.size ?? 0;
  }

  /** End every subscriber's stream (e.g. on shutdown). */
  close(): void {
    for (const set of this.subscribers.values()) {
      for (const subscriber of set) subscriber.end();
    }
    this.subscribers.clear();
  }
}

/** One subscription: a bounded async queue exposed as an `AsyncIterableIterator`. */
class SseSubscriber implements AsyncIterableIterator<SseEvent> {
  private readonly queue: SseEvent[] = [];
  private pending?: (result: IteratorResult<SseEvent>) => void;
  private closed = false;

  constructor(
    private readonly maxQueue: number,
    private readonly onClose: () => void
  ) {}

  push(event: SseEvent): void {
    if (this.closed) return;
    if (this.pending) {
      this.pending({ value: event, done: false });
      this.pending = undefined;
      return;
    }
    this.queue.push(event);
    if (this.queue.length > this.maxQueue) this.queue.shift(); // drop-oldest
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      this.pending({ value: undefined, done: true });
      this.pending = undefined;
    }
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<SseEvent> {
    return this;
  }

  next(): Promise<IteratorResult<SseEvent>> {
    const head = this.queue.shift();
    if (head !== undefined)
      return Promise.resolve({ value: head, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  return(): Promise<IteratorResult<SseEvent>> {
    if (!this.closed) {
      this.closed = true;
      this.onClose(); // unsubscribe from the hub — no leaked subscription
    }
    if (this.pending) {
      this.pending({ value: undefined, done: true });
      this.pending = undefined;
    }
    return Promise.resolve({ value: undefined, done: true });
  }
}
