import { describe, expect, it } from "vitest";
import { SseHub } from "./sse-hub";
import type { SseEvent } from "./sse-hub";

const iterate = (hub: SseHub<string>, key: string): AsyncIterator<SseEvent> =>
  hub.subscribe(key)[Symbol.asyncIterator]();

describe("SseHub", () => {
  it("fans one publish out to every subscriber on the key; keys isolated", async () => {
    const hub = new SseHub<string>();
    const a = iterate(hub, "u1");
    const b = iterate(hub, "u1");
    const c = iterate(hub, "u2");

    hub.publish("u1", { event: "job.updated", data: { id: 1 } });
    expect((await a.next()).value).toEqual({
      event: "job.updated",
      data: { id: 1 },
    });
    expect((await b.next()).value).toEqual({
      event: "job.updated",
      data: { id: 1 },
    });

    hub.publish("u2", { event: "job.created", data: { id: 2 } });
    expect((await c.next()).value).toEqual({
      event: "job.created",
      data: { id: 2 },
    });

    expect(hub.subscriberCount("u1")).toBe(2);
    expect(hub.subscriberCount("u2")).toBe(1);
  });

  it("buffers events published before the consumer reads them", async () => {
    const hub = new SseHub<string>();
    const it = iterate(hub, "k");
    hub.publish("k", { data: 1 });
    hub.publish("k", { data: 2 });
    expect((await it.next()).value).toEqual({ data: 1 });
    expect((await it.next()).value).toEqual({ data: 2 });
  });

  it("unsubscribes on iterator return() — no leaked subscription", async () => {
    const hub = new SseHub<string>();
    const it = iterate(hub, "k");
    expect(hub.subscriberCount("k")).toBe(1);
    await it.return?.();
    expect(hub.subscriberCount("k")).toBe(0);
  });

  it("drops the oldest event past the per-subscriber bound", async () => {
    const hub = new SseHub<string>({ maxQueuePerSubscriber: 2 });
    const it = iterate(hub, "k");
    hub.publish("k", { data: 1 });
    hub.publish("k", { data: 2 });
    hub.publish("k", { data: 3 }); // buffer was [1,2] → 1 is dropped
    expect((await it.next()).value).toEqual({ data: 2 });
    expect((await it.next()).value).toEqual({ data: 3 });
  });

  it("close() ends every subscriber's stream", async () => {
    const hub = new SseHub<string>();
    const it = iterate(hub, "k");
    hub.close();
    expect((await it.next()).done).toBe(true);
    expect(hub.subscriberCount("k")).toBe(0);
  });
});
