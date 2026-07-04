---
sidebar_position: 7
---

# Server-Sent Events (SSE)

Server-Sent Events push a **stream** of events from the server to the client over one long-lived HTTP
connection (`text/event-stream`, the browser's native `EventSource`). SpineJS ships two pieces:

- **`sse()`** — a route marker for a streaming `GET`, a peer of [`get`/`post`](./controllers-handlers).
  Its callback returns an `AsyncIterable<SseEvent>` instead of one value.
- **`SseHub`** — a batteries-included **fan-out** hub, so one server-side event reaches **every** open
  connection for a subject (e.g. all of a user's tabs).

Both live in `@spinejs/http-gateway` — SSE is HTTP-only.

## A streaming route

Write the endpoint like any route, but return a stream. The typical case is _fan-out_: a controller
subscribes each connection to a hub keyed by some subject; a server-side event then reaches every open
subscriber. Follow the natural order — the route, then the hub, then whoever publishes.

```typescript
// jobs.controller.ts — the streaming endpoint
import { Controller } from "@spinejs/gateway-core";
import { sse } from "@spinejs/http-gateway";
import { JobsHub } from "./jobs.hub";

@Controller({ inject: [JobsHub] })
export class JobsController {
  constructor(private readonly jobs: JobsHub) {}

  // GET /jobs/stream → text/event-stream, one open connection per session
  stream = sse("/jobs/stream", {}, (_input, ctx) =>
    this.jobs.subscribe(ctx.user)
  );
  //                                                 ^ returns AsyncIterable<SseEvent>
}
```

```typescript
// jobs.hub.ts — the fan-out; server code calls publish()
import { Injectable } from "@spinejs/core";
import { SseHub } from "@spinejs/http-gateway";

@Injectable()
export class JobsHub {
  private readonly hub = new SseHub<string>(); // keyed by userId

  subscribe(userId: string) {
    return this.hub.subscribe(userId); // AsyncIterable<SseEvent>
  }

  // called wherever a job changes (e.g. a Postgres LISTEN/NOTIFY bridge) → fans out to all the user's tabs
  onJobWrite(userId: string, job: { id: string; status: string }) {
    this.hub.publish(userId, { event: job.status, data: job });
  }
}
```

That is the whole surface: **`sse()`** declares the endpoint, **`SseHub`** fans out. A `GET /jobs/stream`
broadcasting `job.created / updated / completed` to every one of an assignee's open sessions is ~15 lines.

An `SseEvent` maps to the SSE wire fields:

```typescript
interface SseEvent {
  data: unknown; // JSON-serialized to the `data:` field (a string is sent as-is)
  event?: string; // the `event:` name (the client's `addEventListener(name, …)`)
  id?: string; // the `id:` field — surfaces as `Last-Event-ID` on reconnect
  retry?: number; // reconnect backoff hint (ms)
}
```

On the client, this is the standard browser API — no SpineJS client:

```typescript
const es = new EventSource("/jobs/stream");
es.addEventListener("completed", (e) => console.log(JSON.parse(e.data)));
```

## Do

### Guard a stream

A stream is authenticated **once, at open**. Pass `guards` exactly like a normal route — they run before
anything is streamed, and a rejection returns a normal JSON error (never a half-open stream):

```typescript
stream = sse("/jobs/stream", { guards: [AuthGuard] }, (_input, ctx) =>
  this.jobs.subscribe(ctx.user)
);
```

### Validate `params` / `query`

`sse()` validates `params` and `query` like any route (it is a `GET`, so there is no `body`). The
inferred `input` reaches the callback the same way:

```typescript
stream = sse(
  "/rooms/:id/stream",
  { params: z.object({ id: z.string().uuid() }) },
  ({ params }, ctx) => this.rooms.subscribe(params.id, ctx.user)
);
```

### Stream without a hub

The handler only has to return an `AsyncIterable<SseEvent>` — an async generator works when there is no
fan-out, just a per-connection feed:

```typescript
ticks = sse("/clock", {}, async function* () {
  for (;;) {
    yield { event: "tick", data: { at: new Date().toISOString() } };
    await new Promise((r) => setTimeout(r, 1000));
  }
});
```

### Tune the heartbeat

The transport writes a `: ping` comment on an idle connection so proxies don't kill it. The interval is
`sseHeartbeatMs` on the HTTP module (default `15_000`; `0` disables it):

```typescript
HttpGatewayModule.configure({
  imports: [],
  contextFactory: { value: new AppContextFactory() },
  sseHeartbeatMs: 30_000,
});
```

### Backpressure

A slow client cannot make the server grow memory without bound. Each subscriber has a bounded queue
(`maxQueuePerSubscriber`, default `1000`); past the cap the **oldest** event is dropped. SSE is a
best-effort wakeup — the client re-syncs on reconnect — so shedding old events beats an unbounded buffer:

```typescript
private readonly hub = new SseHub<string>({ maxQueuePerSubscriber: 200 });
```

### Disconnect is automatic

When the client closes the connection, the transport calls the iterator's `return()`, which unsubscribes
from the hub and drops the empty key — no leaked subscriptions, nothing to clean up by hand.

:::caution An SSE route bypasses interceptors and the CLS scope
Unlike a buffered route, an SSE connection runs **no** interceptor chain and opens **no** per-request
[CLS scope](../extensions/cls). A CLS scope brackets a short unit of work and releases its scoped
resources (a DB transaction, a store) at the end; a stream lives for minutes or hours, so holding one
open for its whole lifetime would be a leak. The handler receives `ctx` **directly** and reads what it
needs at open time. Producing the data that gets streamed is the writer's job on the `POST` side, inside
its own request scope — the SSE endpoint only fans it back out.
:::

## Reference

### `sse(path, options, handler)`

A module-level route function (import from `@spinejs/http-gateway`), declared as a controller instance
field. Always `GET`. `handler: (input, ctx) => AsyncIterable<SseEvent>`; `input` is inferred from
`params`/`query`, `ctx` defaults to your registered app context (see [Controllers and
Routes](./controllers-handlers)).

`SseRouteOptions` (the second argument):

| Option    | Type                     | Description                                                            |
| --------- | ------------------------ | ---------------------------------------------------------------------- |
| `params`  | `ParseableSchema<P>`     | Schema for path params. When present, `input.params` is validated.     |
| `query`   | `ParseableSchema<Q>`     | Schema for the query string. When present, `input.query` is validated. |
| `guards`  | `GuardConstructor[]`     | Per-route guards; run once at open, before anything is streamed.       |
| `headers` | `Record<string, string>` | Static headers added to the `text/event-stream` response.              |

There is no `body`, `successStatus`, or `response` — the stream owns the response.

### `SseHub<K = string>`

An in-memory fan-out keyed by `K` (events are always `SseEvent`, so only the key is generic).

| Member                                    | Description                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------- |
| `new SseHub(options?)`                    | `options: SseHubOptions`.                                                  |
| `subscribe(key): AsyncIterable<SseEvent>` | Open a stream for `key`; `for await` it. Breaking/returning unsubscribes.  |
| `publish(key, event): void`               | Push `event` to every open subscriber on `key`. No-op when there are none. |
| `subscriberCount(key): number`            | Live subscriber count for `key` (introspection / tests).                   |
| `close(): void`                           | End every subscriber's stream (e.g. on shutdown).                          |

`SseHubOptions`:

| Option                  | Type     | Default | Description                                                               |
| ----------------------- | -------- | ------- | ------------------------------------------------------------------------- |
| `maxQueuePerSubscriber` | `number` | `1000`  | Max events buffered for one slow subscriber before the oldest is dropped. |

### `SseEvent`

| Field   | Type      | Description                                                |
| ------- | --------- | ---------------------------------------------------------- |
| `data`  | `unknown` | JSON-serialized to `data:` (a string is sent as-is).       |
| `event` | `string?` | The `event:` name (defaults to the browser's `message`).   |
| `id`    | `string?` | The `id:` field; surfaces as `Last-Event-ID` on reconnect. |
| `retry` | `number?` | Reconnect backoff hint (ms).                               |

### Heartbeat config

`HttpGatewayModule.configure({ sseHeartbeatMs })` — keep-alive comment interval (default `15_000`, `0`
disables). See the [HTTP transport](../transports/http) page for the full `configure()` surface.

The design rationale (why SSE folds into `http-gateway` and bypasses the envelope/interceptors/CLS) is
recorded in ADR 0017 (`docs/adr/0017-sse-fan-out-in-http-gateway.md`).
