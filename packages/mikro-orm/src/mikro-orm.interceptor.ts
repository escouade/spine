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
 * `begin` → `commit` (flush, no explicit `.save()`) on success, `rollback` + rethrow on error.
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
      await em.commit(); // flush the unit-of-work, then COMMIT — no explicit .save()
      return res;
    } catch (e) {
      await em.rollback(); // discard; the identity map dies with the scope
      throw e; // never swallowed — propagates to the gateway's error path (ADR 0016 §5)
    }
  }
}
