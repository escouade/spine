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
 * transactional unit-of-work, with **nothing threaded through service signatures**.
 *
 * It forks a fresh `EntityManager` — one identity map, one unit-of-work — stores it in CLS (so every
 * injected `EntityManager`/repository resolves to it via `getContext()`), and brackets the dispatch:
 * `begin` → `commit` (flush, no explicit `.save()`) on a **successful** envelope, `rollback` on an
 * error envelope or a thrown error.
 *
 * The dispatch pipeline (`@spinejs/gateway-core`) **never throws** — guard/validation/handler failures
 * come back as `{ ok: false, code }`, they do not reject `next()`. So the commit/rollback decision is
 * driven by the envelope's `ok`, not by a try/catch: committing unconditionally would persist the
 * unit-of-work on every application error. The `catch` only handles an interceptor-level throw or a
 * failing `commit`/`rollback`.
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
    await em.begin();
    try {
      const res = await next();
      // The pipeline never throws: application errors come back as `{ ok: false }`. Commit only a
      // successful unit-of-work; roll back on an error envelope — nothing is persisted (ADR 0016 §2).
      if (res.ok) {
        await em.commit(); // flush the unit-of-work, then COMMIT — no explicit .save()
      } else {
        await em.rollback(); // discard; the identity map dies with the scope
      }
      return res;
    } catch (e) {
      // Interceptor-level throw, or a commit/rollback failure: discard any open transaction and
      // propagate. Never swallowed — the error reaches the gateway's error path (ADR 0016 §5).
      if (em.isInTransaction()) await em.rollback();
      throw e;
    }
  }
}
