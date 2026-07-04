import { Injectable } from "@spinejs/core";
import { MikroORM } from "@mikro-orm/core";
import { ClsService } from "@spinejs/cls";
import type {
  DispatchTarget,
  Envelope,
  GatewayContext,
  GatewayInterceptor,
} from "@spinejs/gateway-core";
import { EM } from "./mikro-orm.options";

/**
 * The differentiator (ADR 0016 §2). A gateway interceptor that gives every dispatch its own
 * request-scoped unit-of-work, with **nothing threaded through service signatures**.
 *
 * It forks a fresh `EntityManager` — one identity map, one unit-of-work — stores it in CLS (so every
 * injected `EntityManager`/repository resolves to it via `getContext()`), runs the dispatch, and
 * **flushes once at the end on a successful envelope** (`flush`, no explicit `.save()`). There is no
 * up-front `begin()`: `flush()` wraps the request's pending changes in a single implicit transaction,
 * so a write is still atomic, yet a request that writes nothing opens no transaction and holds no
 * connection across its work — read-only and DB-free dispatches pay nothing.
 *
 * The dispatch pipeline (`@spinejs/gateway-core`) **never throws** — guard/validation/handler failures
 * come back as `{ ok: false, code }`, they do not reject `next()`. So the flush decision is driven by
 * the envelope's `ok`, not by a try/catch: an error envelope is never flushed (nothing is persisted —
 * the fork is dropped with the scope, and nothing was ever flushed, so there is nothing to roll back),
 * and a failing flush propagates to the gateway's error path — never swallowed.
 *
 * Must run **inside** the CLS scope opened by `ClsInterceptor` (ADR 0003): register it in the gateway
 * `configure({ interceptors })` **after** `ClsInterceptor`. Without an active scope, `cls.set()` throws.
 */
@Injectable({ inject: [MikroORM, ClsService] })
export class MikroOrmInterceptor implements GatewayInterceptor {
  constructor(
    private readonly orm: MikroORM,
    private readonly cls: ClsService
  ) {}

  async intercept(
    _target: DispatchTarget<GatewayContext>,
    _ctx: GatewayContext,
    _rawInput: unknown,
    next: () => Promise<Envelope<unknown>>
  ): Promise<Envelope<unknown>> {
    // `orm.em` is always the ROOT manager; `.fork()` yields a fresh per-request manager. Storing it in
    // CLS makes `orm.em`'s operations delegate to it through the `context` hook (ADR 0016 §1-2).
    const em = this.orm.em.fork();
    this.cls.set(EM, em);

    const res = await next();

    // No up-front `begin()`: the unit-of-work is flushed once, at the end, and ONLY on a successful
    // envelope. The pipeline never throws — guard/validation/handler failures come back as
    // `{ ok: false }` — so this drives the flush, not a try/catch. `flush()` wraps the pending changes
    // in a single implicit transaction (atomic, no explicit `.save()`); a request that wrote nothing
    // flushes nothing, so a read-only or DB-free dispatch opens no transaction and holds no connection
    // across its work. An error envelope persists nothing — the fork is dropped with the scope, and
    // nothing was ever flushed, so there is nothing to roll back. A failing `flush()` (e.g. a
    // constraint violation) throws out of here; the pipeline maps it to an error code (ADR 0016 §2, §5).
    if (res.ok) {
      await em.flush();
    }
    return res;
  }
}
