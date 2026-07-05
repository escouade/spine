import { Logger } from "@spinejs/core";
import { MikroORM } from "@mikro-orm/core";
import { ClsService } from "@spinejs/cls";
import type {
  DispatchTarget,
  Envelope,
  GatewayContext,
  GatewayInterceptor,
} from "@spinejs/gateway-core";
import { EM, WROTE } from "./mikro-orm.options";

/** Log context tag for the interceptor's diagnostics. */
const CONTEXT = "MikroOrmInterceptor";

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
 * `configure({ interceptors })` **after** `ClsInterceptor`. Without an active scope it fails fast with a
 * clear, logged diagnostic naming the wiring fix (not an opaque store-write error mapped to a code).
 *
 * With **multiple connections** (ADR 0016, Amendment 1) each connection has its own interceptor,
 * parameterised by its CLS `key` (which fork it brackets) and its `multiWrite` flag. The default
 * connection uses the plain {@link EM} key and `multiWrite: false` — the defaults its factory provider
 * supplies — so single-connection behaviour is unchanged. A per-request write-once guard ({@link WROTE})
 * makes writing more than one connection in a request throw, unless **every** written connection opted
 * into best-effort `multiWrite`.
 */
export class MikroOrmInterceptor implements GatewayInterceptor {
  constructor(
    private readonly orm: MikroORM,
    private readonly cls: ClsService,
    private readonly log: Logger,
    // Both connections construct the interceptor through a factory provider (see MikroOrmModule): the
    // default connection passes the defaults — the plain EM key, no cross-write opt-in — and a named
    // connection passes its own `emKey(name)` and `multiWrite` flag.
    private readonly key: string = EM,
    private readonly multiWrite: boolean = false
  ) {}

  async intercept(
    _target: DispatchTarget<GatewayContext>,
    _ctx: GatewayContext,
    _rawInput: unknown,
    next: () => Promise<Envelope<unknown>>
  ): Promise<Envelope<unknown>> {
    // Fail fast with an actionable diagnostic when the interceptor runs outside a CLS scope — the
    // wiring mistake (missing or misordered ClsInterceptor). Otherwise `cls.set()` throws an opaque
    // store-write error the pipeline maps to a generic code, hiding the real cause (ADR 0016 §5).
    if (!this.cls.active) {
      const message =
        "@spinejs/mikro-orm: MikroOrmInterceptor ran without an active CLS scope. Register it AFTER " +
        "ClsInterceptor — configure({ interceptors: [ClsInterceptor, MikroOrmInterceptor] }) — so it " +
        "runs inside the request scope.";
      this.log.error(message, CONTEXT);
      throw new Error(message);
    }

    // `orm.em` is always the ROOT manager; `.fork()` yields a fresh per-request manager. Storing it under
    // THIS connection's key makes its `orm.em` operations delegate to it via the `context` hook, and
    // keeps N connections' forks apart in the one request scope (ADR 0016 §1-2 / Amendment 1).
    //
    // `disableContextResolution` is REQUIRED: `fork()` otherwise consults the `context` hook to find the
    // current em, but a named connection's hook THROWS when no fork is set yet (the leak guard) — exactly
    // the state we are in while creating that first fork. The flag forks straight from the root, breaking
    // the chicken-and-egg; the default connection's non-throwing hook makes it a harmless no-op there.
    const em = this.orm.em.fork({ disableContextResolution: true });
    this.cls.set(this.key, em);

    const res = await next();

    // Flush once, at the end, ONLY on a successful envelope. The pipeline never throws — guard/
    // validation/handler failures come back as `{ ok: false }` — so this drives the flush, not a
    // try/catch. An error envelope persists nothing (the fork is dropped with the scope; nothing was
    // flushed, nothing to roll back).
    if (res.ok) {
      // Dirty detection: compute the pending change sets first (in-memory — this opens NO transaction)
      // and flush only if the request actually wrote through THIS connection. A read-only dispatch never
      // begins a transaction, preserving the lazy-flush property (ADR 0016 §2). Change-set computation
      // (not just the persist/remove stacks) is what catches a mutation to an already-loaded entity.
      //
      // Mirror MikroORM's OWN "nothing to flush" gate (UnitOfWork.doCommit): entity change sets are not
      // the whole story. A collection-only change — an M:N / pivot `add`/`remove` with no scalar edit —
      // lands in `collectionUpdates`, and `computeChangeSet` returns null for the owning entity (empty
      // scalar payload), so it never appears in `getChangeSets()`; deferred 1:1 / unique-nullable writes
      // land in `extraUpdates`. Gating on `getChangeSets()` alone would skip the flush and silently drop
      // those writes (the pre-Amendment unconditional `flush()` caught them). Check all three sets.
      const uow = em.getUnitOfWork();
      uow.computeChangeSets();
      const dirty =
        uow.getChangeSets().length > 0 ||
        uow.getCollectionUpdates().length > 0 ||
        uow.getExtraUpdates().size > 0;
      if (dirty) {
        // Write-once guard (Amendment 1 / decision 2C), enforced ALL-OR-NOTHING and order-independent.
        // MikroORM has no two-phase commit, so writes to two connections cannot be atomic. Once ANY
        // connection has written this request, EVERY connection that writes must have opted into
        // `multiWrite` — this one AND the connection that wrote first. Otherwise refuse loudly. This is
        // NOT a rollback: interceptors unwind innermost-first, so the connection that wrote first may
        // already have flushed/committed; the throw makes the unsound cross-DB write loud, it does not
        // undo it. With a single connection `WROTE` is set once and the guard never trips.
        if (this.cls.has(WROTE)) {
          const firstOptedIntoMultiWrite = this.cls.get(WROTE) === true;
          if (!this.multiWrite || !firstOptedIntoMultiWrite) {
            const message =
              "@spinejs/mikro-orm: more than one connection was written in a single request, but not " +
              "every connection opted into multiWrite. Cross-DB writes have no atomicity (MikroORM has " +
              "no two-phase commit); set multiWrite: true on every connection written in the request — " +
              "configure({ name, multiWrite: true }) — to allow best-effort sequential flush.";
            this.log.error(message, CONTEXT);
            throw new Error(message);
          }
        } else {
          // First writer: record whether IT opted into multiWrite, so a later writer can enforce the
          // symmetry above (a second write is allowed only when both connections opted in).
          this.cls.set(WROTE, this.multiWrite);
        }
        // `flush()` wraps the pending changes in a single implicit transaction (atomic, no `.save()`).
        // A failing flush (e.g. a constraint violation) throws out of here; the pipeline maps it to an
        // error code (ADR 0016 §2, §5).
        await em.flush();
      }
    }
    return res;
  }
}
