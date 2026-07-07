# ADR 0017 — Server-Sent Events fan-out in `@spinejs/http-gateway`

- **Status**: Accepted — **amended** by [ADR 0022](0022-connect-interceptor-capability-marker.md) (§3)
- **Date**: 2026-07-04
- **Scope**: `packages/http-gateway` only (`http-routes.ts`, `http.gateway.ts`, `http-gateway.module.ts`,
  new `sse-hub.ts`). `packages/gateway-core` is **untouched**.
- **Relation**: extends the HTTP transport of [ADR 0005](0005-gateway-composition-http-transport.md) and
  the field-form route markers of [ADR 0004](0004-field-form-routes.md); deliberately steps **outside**
  the `Envelope` contract of [ADR 0002](0002-gateway-transport-agnostic.md) and the CLS request scope of
  [ADR 0003](0003-cls-request-context.md) (see §2). First of two "server batteries" built cold per
  studio ADR 0017 §3; the second is [ADR 0018](0018-cls-scoped-scheduling.md). ORM (spine ADR 0016) is
  the third.

:::note Amended by ADR 0022 (§3)
§3 below states the SSE path skips the interceptor chain entirely. As of [ADR 0022](0022-connect-interceptor-capability-marker.md),
a **connect-phase subset** of `interceptors` — those implementing `ConnectInterceptor` — runs at the
connection **attempt** (before guards), via `interceptConnect`. The streaming **body** still bypasses the
buffered pipeline and CLS scope exactly as described here; only the one-shot connect is enforced. Read "the
interceptor chain does not run" below as "the buffered request pipeline does not wrap the stream".
:::

## Context

A server backend needs **server→client push**: one endpoint that streams events over a long-lived
connection instead of returning one value. The concrete driver is studio ADR 0016 §4 — broadcast a job
write (`created/updated/completed/failed/awaiting-input`) to **all** of an assignee's open sessions,
fed by a Postgres `LISTEN/NOTIFY` bridge. Server-Sent Events (`text/event-stream`) is the transport:
one-way, plain HTTP, native `EventSource` reconnect.

Spine has no streaming machinery. Its whole dispatch model is _one awaited value_:
`DispatchTarget.invoke` returns a single result, wrapped in an `Envelope {ok, data}`, JSON-stringified
into one `Response`. That `Envelope` contract is **shared by HTTP and Electron IPC** through
`gateway-core` (ADR 0002/0005) and must stay pure — a buffered single value, transport-agnostic. An SSE
response is the opposite: N values over an open connection, and it is **HTTP-only** (IPC has no
equivalent). It therefore cannot flow through the normal buffered pipeline, and it must not enter
`gateway-core`.

Two things are needed: a way to **declare** an SSE endpoint (a new route kind), and a **fan-out
primitive** so one server-side event reaches every open connection for a subject. NestJS answers the
first with `@Sse()` returning an `Observable<MessageEvent>` (a per-connection stream) and leaves fan-out
to the app (an rxjs `Subject` per key, hand-rolled). Spine has no rxjs and one concrete fan-out use
case.

## Decision

Add SSE as **HTTP-package-local** additions to `@spinejs/http-gateway`: a `sse()` route marker, a
parallel streaming dispatch path branched off `meta.sse`, and a batteries-included `SseHub` fan-out.
Everything reuses the route's guards and input validation but **bypasses** the `Envelope` buffering, the
interceptor chain, and the per-request CLS scope.

### 1. `sse()` — a GET-only field-form route marker

`sse(path, opts, handler)` mirrors `get`/`post` (ADR 0004): it builds a branded `RouteMarker`,
discovered by the same `getRoutes()` field scan, carrying an extra HTTP-meta flag. `HttpRouteMeta` gains
`sse?: boolean`; the marker is GET-only (an event stream is a read). The handler returns an
`AsyncIterable<SseEvent>` instead of one value:

```ts
@Controller({ inject: [JobsHub] })
export class JobsController {
  // GET /jobs/stream → text/event-stream
  stream = sse("/jobs/stream", {}, (_input, ctx) =>
    this.jobs.subscribe(ctx.user.id)
  );
  constructor(private jobs: JobsHub) {}
}
```

```ts
interface SseEvent {
  data: unknown; // JSON-serialized to the `data:` field (unless already a string)
  event?: string; // `event:` name
  id?: string; // `id:` — surfaces as Last-Event-ID on reconnect
  retry?: number; // client reconnect backoff hint (ms)
}
```

### 2. A parallel streaming dispatch, branched in `HttpGateway.bind`

`bind` branches on `meta.sse` into `dispatchSse` — a path that reuses the auth/context machinery but
replaces the "buffer one envelope" tail with Hono's `streamSSE` (`hono/streaming`, already a transitive
dep of `@hono/node-server` — no new dependency, no touching Node `ServerResponse`):

```ts
if (meta?.sse) {
  this.app.on(method, path, (c) => this.dispatchSse(route, c));
  return;
}
```

`dispatchSse` runs **guards + validation up front** (a failure streams nothing — it returns a normal
JSON error envelope, exactly like a buffered route), verifies the handler actually returned an
`AsyncIterable` (otherwise a proper error, not a silent empty `200`), applies the route's `headers`, then
hands off to `streamSSE`. `pumpSse` iterates the async iterator to the wire until the client
disconnects.

### 3. Guards run inline; the interceptor chain and CLS scope do not

A `LoadedRoute` **already carries its resolved guard instances** (they were resolved at load time for the
normal path). The SSE path calls `guard.canActivate(ctx)` on them inline — so authentication/authorization
is identical to a buffered route, with **no** `gateway-core` change and **no** duplicated resolution.

What it deliberately skips:

- **The interceptor chain** — including the `ClsInterceptor` (ADR 0003). An SSE connection opens **no
  per-connection CLS scope**. A CLS scope is a _request_ boundary meant to bracket a short unit of work
  and release its scoped resources (a DB transaction, a store) at the end. An SSE stream lives for
  minutes or hours; holding a scoped transaction open for its whole lifetime would be a resource leak, not
  a feature. The handler receives `ctx` **directly** and reads what it needs at open time.
- **The `Envelope`** — the stream _is_ the response; there is no single value to wrap.

Producing the data that gets streamed is the **writer's** job on the normal (POST) side, inside its own
request scope; the SSE endpoint only fans it back out.

### 4. `SseHub<K = string>` — the batteries-included fan-out

The fan-out primitive is in-memory, zero-dep, keyed by `K` (events are always `SseEvent`, so only the key
is generic):

```ts
class SseHub<K = string> {
  subscribe(key: K): AsyncIterable<SseEvent>; // bounded queue; return()/break unsubscribes
  publish(key: K, event: SseEvent): void; // push to every open subscriber on key
  subscriberCount(key: K): number; // introspection / tests
  close(): void; // end every stream (shutdown)
}
```

Each subscriber is a small bounded async queue (`SseSubscriber implements AsyncIterableIterator`). One
`publish(key, ev)` pushes to every subscriber under `key`; a subscriber's `return()` (called when the
client disconnects — see §5) removes it from the hub, and the key's `Set` is dropped when it empties — no
leaked subscriptions.

### 5. Disconnect, backpressure, heartbeat

- **Disconnect → unsubscribe.** `pumpSse` registers `stream.onAbort(() => it.return?.())`; the iterator's
  `return()` is where `SseHub` removes the subscriber. The `return()` is idempotent and also runs in a
  `finally`, so the unsubscribe happens exactly once whether the client drops or the stream ends.
- **Backpressure = bounded + drop-oldest.** A slow client's queue is capped (`maxQueuePerSubscriber`,
  default `1000`); past the cap the **oldest** event is dropped. SSE is a best-effort wakeup (studio ADR
  0016 — clients re-sync on reconnect, delivery is never guaranteed), so a bounded queue that sheds old
  events beats unbounded memory growth. The bound is explicit, not accidental.
- **Heartbeat.** `pumpSse` writes a `: ping` comment every `sseHeartbeatMs` (default `15_000`, `0`
  disables), configured via `HttpGatewayModule.configure({ sseHeartbeatMs })`, to stop intermediaries
  from killing an idle connection. The heartbeat timer is `unref()`ed and its write is `.catch`-guarded.
- **Poison-event isolation.** Each event is serialized and written in its own `try/catch`, with safe
  serialization (a `BigInt`, a circular object, `undefined`, a newline in `id`) — one bad event can't
  tear the whole stream down.

## Alternatives considered

### A new `@spinejs/sse` package for the hub

Considered: the hub is a generic keyed pub/sub, reusable beyond HTTP. Rejected for MVP by the **Rule of
Three**: it has exactly one consumer today (the HTTP SSE path). Folding it into `@spinejs/http-gateway`
keeps the package count down and co-locates it with its only user. Extract when a second consumer
appears — the hub has no HTTP dependency, so the move is mechanical.

### Push SSE into `gateway-core` (transport-agnostic streaming)

Rejected outright. `gateway-core` is the shared HTTP+IPC core; its `Envelope` "single awaited value"
contract (ADR 0002) is the whole reason IPC and HTTP share a pipeline. A long-lived N-value stream is
HTTP-only and would pollute that contract with a streaming type IPC can never honor. SSE stays entirely
in the HTTP package; the core never learns the word "stream".

### Open a per-connection CLS scope for the stream (reuse `ClsInterceptor`)

Rejected: a CLS scope brackets a _request_ and is meant to release scoped resources at its end. An SSE
connection is long-lived; a scope spanning it would hold a transaction/store open for the connection's
lifetime — a leak. The handler gets `ctx` directly instead and reads what it needs at open time; scoped
work (writing the data) happens on the POST side, in its own scope.

### Fan-out via rxjs `Subject` (the NestJS shape)

Rejected: spine has no rxjs and adding it for one hub is disproportionate. The cost of _not_ having rxjs
is ~100 lines of async-queue code we own (the `SseSubscriber` bounded queue) — which is exactly the code
an app on NestJS would hand-roll anyway to get keyed fan-out on top of `@Sse()` (which only gives a
per-connection stream). Shipping the hub as the battery makes the studio use case declarative.

### Last-Event-ID replay as a delivery guarantee

Not built. The `id` field surfaces as `Last-Event-ID` on reconnect and a handler _may_ read it to replay,
but SSE guarantees nothing (studio ADR 0016: the fallback is always a poll). Replay is left as a
documented handler hook, not a framework guarantee — the framework would otherwise be promising
at-least-once delivery it can't back.

## Consequences

- **Positive**: `gateway-core` is untouched — the shared HTTP+IPC `Envelope` contract stays pure; SSE is
  a purely additive, HTTP-local capability.
- **Positive**: authentication is identical to a normal route — the same resolved guard instances run
  inline, no duplicated logic, no auth divergence between buffered and streamed endpoints.
- **Positive**: the fan-out the studio use case needs (one job write → all of a user's tabs) is ~15 lines
  of app code (`sse()` + `SseHub`), declarative, no rxjs.
- **Positive**: bounded backpressure and heartbeat are built-in and explicit — a slow or idle client
  degrades predictably (drop-oldest, keep-alive) instead of leaking memory or being killed by a proxy.
- **Negative**: SSE endpoints do **not** get the interceptor chain or a CLS scope — a handler that
  assumes ambient request context (e.g. `cls.get("user")` deep in a service) will not find one on an SSE
  route. This is by design; the handler must read from `ctx` at open time. Documented as a sharp edge.
- **Negative**: the hub is in-memory and per-instance — fan-out only reaches subscribers on the **same**
  process. Multi-replica fan-out needs an external bus (the `LISTEN/NOTIFY` bridge that feeds `publish`
  is what crosses instances); the hub is deliberately not a distributed pub/sub.
- **Caution**: `data` is JSON-serialized per event; a non-serializable payload is coerced safely
  (`"null"`) rather than throwing, so a malformed event is silently degraded, not surfaced — validate
  payloads on the `publish` side if that matters.
