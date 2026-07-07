import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  MikroORM,
  EntityManager,
  EntitySchema,
  Collection,
} from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { ClsService, ClsInterceptor } from "@spinejs/cls";
import { assertConnectInterceptorsSafe } from "@spinejs/gateway-core";
import type {
  ChainInterceptor,
  DispatchTarget,
  Envelope,
  GatewayContext,
} from "@spinejs/gateway-core";
import { MikroOrmInterceptor } from "./mikro-orm.interceptor";
import { mikroOrmProvider, entityManagerProvider } from "./mikro-orm.module";
import { EM } from "./mikro-orm.options";
import type { Logger } from "@spinejs/core";

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;

// --- Entity via EntitySchema (no decorators, ADR 0016 NFR1) --------------------------------------
class Tag {
  id!: number;
  label!: string;
}
const TagSchema = new EntitySchema<Tag>({
  class: Tag,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    label: { type: "string" },
  },
});

class Widget {
  id!: number;
  name!: string;
  // A M:N collection: adding a link is a pivot-only write — the owning entity has no dirty scalar, so
  // it is absent from `getUnitOfWork().getChangeSets()` (it lands in `getCollectionUpdates()`).
  tags = new Collection<Tag>(this);
}
const WidgetSchema = new EntitySchema<Widget>({
  class: Widget,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    name: { type: "string" },
    tags: { kind: "m:n", entity: () => Tag },
  },
});

// A service holding ONLY the injected EntityManager — no manager threaded per call, no ctx argument.
// It uses `orm.em` (the root, provided by entityManagerProvider), which delegates each op to the
// current request's fork via getContext() — the differentiator (ADR 0016 §2).
class WidgetService {
  constructor(private readonly em: EntityManager) {}
  create(name: string): void {
    this.em.persist(this.em.create(Widget, { name }));
  }
  async rename(id: number, name: string): Promise<void> {
    const w = await this.em.findOneOrFail(Widget, { id });
    w.name = name; // dirty-tracked; committed at request end. No .save().
  }
  find(id: number): Promise<Widget | null> {
    return this.em.findOne(Widget, { id });
  }
  count(): Promise<number> {
    return this.em.count(Widget, {});
  }
}

describe("MikroOrmInterceptor — request-scoped transactional EM (Story 1.3)", () => {
  let orm: MikroORM;
  let cls: ClsService;
  let clsInterceptor: ClsInterceptor<GatewayContext>;
  let mikro: MikroOrmInterceptor;
  let svc: WidgetService;

  const target: DispatchTarget<GatewayContext> = {
    guards: [],
    invoke: () => undefined,
  };
  const ctx: GatewayContext = {};

  // Simulate a full dispatch: ClsInterceptor opens the scope (ADR 0003), MikroOrmInterceptor forks +
  // brackets the transaction, then the handler runs. Mirrors an app's interceptor chain order.
  const dispatch = (handler: () => Promise<void>): Promise<Envelope<unknown>> =>
    clsInterceptor.intercept(target, ctx, undefined, () =>
      mikro.intercept(target, ctx, undefined, async () => {
        await handler();
        return { ok: true, data: undefined };
      })
    );

  beforeEach(async () => {
    cls = new ClsService();
    orm = mikroOrmProvider.factory(cls, {
      driver: BetterSqliteDriver,
      dbName: ":memory:",
      entities: [WidgetSchema, TagSchema],
    });
    await orm.connect();
    await orm.schema.createSchema();
    clsInterceptor = new ClsInterceptor(cls);
    mikro = new MikroOrmInterceptor(orm, cls, silentLogger);
    svc = new WidgetService(entityManagerProvider.factory(orm));
  });

  afterEach(async () => {
    await orm.close(true);
  });

  it("persists an inserted entity at commit with no explicit .save()", async () => {
    await dispatch(async () => svc.create("alpha"));

    let name: string | undefined;
    await dispatch(async () => {
      name = (await svc.find(1))?.name;
    });
    expect(name).toBe("alpha");
  });

  it("commits a mutation to a loaded entity with no .save() and no manager threaded in", async () => {
    await dispatch(async () => svc.create("before"));
    await dispatch(async () => svc.rename(1, "after"));

    let name: string | undefined;
    await dispatch(async () => {
      name = (await svc.find(1))?.name;
    });
    expect(name).toBe("after");
  });

  it("flushes a collection-only change (M:N pivot link) that getChangeSets() alone would miss", async () => {
    // Seed a widget and a tag with their own request (scalar inserts — flush unaffected).
    await dispatch(async () => {
      const em = orm.em.getContext();
      em.persist(em.create(Widget, { name: "w" }));
      em.persist(em.create(Tag, { label: "t" }));
    });

    // A request whose ONLY change is a M:N link: no scalar edit on either entity, so the owning entity
    // never appears in getChangeSets() — the write lives solely in the collection-updates set. The
    // pre-fix gate (getChangeSets().length > 0) skipped the flush here and silently dropped the pivot row.
    await dispatch(async () => {
      const em = orm.em.getContext();
      const w = await em.findOneOrFail(
        Widget,
        { id: 1 },
        { populate: ["tags"] }
      );
      const t = await em.findOneOrFail(Tag, { id: 1 });
      w.tags.add(t);
    });

    let links: number | undefined;
    await dispatch(async () => {
      const w = await orm.em
        .getContext()
        .findOneOrFail(Widget, { id: 1 }, { populate: ["tags"] });
      links = w.tags.length;
    });
    expect(links).toBe(1); // the collection-only write was flushed, not dropped
  });

  it("rolls back on error — nothing is persisted — and rethrows", async () => {
    await dispatch(async () => svc.create("keep"));

    await expect(
      dispatch(async () => {
        svc.create("doomed");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    let count: number | undefined;
    await dispatch(async () => {
      count = await svc.count();
    });
    expect(count).toBe(1); // only "keep" survived
  });

  it("stores the fork in CLS so orm.em.getContext() resolves to the request's fork (not the root)", async () => {
    await dispatch(async () => {
      const fork = cls.get(EM);
      expect(orm.em.getContext()).toBe(fork);
      expect(orm.em.getContext()).not.toBe(orm.em); // root ≠ request fork
    });
  });

  it("isolates two concurrent requests — each sees its own fork across an await", async () => {
    const seen: EntityManager[] = [];
    const run = () =>
      dispatch(async () => {
        const mine = orm.em.getContext();
        await new Promise((r) => setTimeout(r, 10));
        expect(orm.em.getContext()).toBe(mine); // still mine after the await
        seen.push(mine);
      });

    await Promise.all([run(), run()]);
    expect(seen[0]).not.toBe(seen[1]); // two requests, two forks
  });

  it("opens NO transaction for a request that writes nothing (lazy flush — read-only pays no BEGIN/COMMIT)", async () => {
    await dispatch(async () => svc.create("seed")); // its own request seeds a row

    let inTx: boolean | undefined;
    await dispatch(async () => {
      await svc.find(1); // read only — nothing dirty
      inTx = orm.em.getContext().isInTransaction();
    });
    expect(inTx).toBe(false); // no up-front begin(): a read-only dispatch never opens a transaction
  });

  it("drops into a transport-narrowed ChainInterceptor slot with no cast (the union admits the base interceptor)", () => {
    // Stand-in for a transport's narrowed context + route (narrows Ctx and adds address/meta, like an
    // IpcRoute/HttpRoute). The assignment compiles with NO cast only because `ChainInterceptor`'s union
    // admits a transport-agnostic base interceptor — the compile-time regression guard that keeps
    // `configure({ interceptors: [..., orm] })` free of a hand-written `as`.
    type NarrowCtx = GatewayContext & { user: string };
    type NarrowRoute = DispatchTarget<NarrowCtx> & { address: string };
    const slot: ChainInterceptor<NarrowCtx, string, NarrowRoute> = mikro;
    expect(slot).toBe(mikro); // the same instance — no wrapper, no assertion
  });

  it("fails fast with a clear, logged diagnostic when run outside a CLS scope", async () => {
    const errors: string[] = [];
    const recLogger = {
      ...silentLogger,
      error: (m: unknown) => errors.push(String(m)),
    } as unknown as Logger;
    const bare = new MikroOrmInterceptor(orm, cls, recLogger);

    await expect(
      bare.intercept(target, ctx, undefined, async () => ({
        ok: true,
        data: undefined,
      }))
    ).rejects.toThrow(/active CLS scope/);
    // The actionable message is surfaced (logged), not swallowed into a generic pipeline code.
    expect(errors.some((m) => /ClsInterceptor/.test(m))).toBe(true);
  });
});

describe("MikroOrmInterceptor — connect-safety marker (ADR 0024)", () => {
  it("declares requestScoped, so a gateway boot-assert catches it if it ever gained interceptConnect", () => {
    // Constructing is enough — the constructor only stores; we assert the static marker, not behavior.
    const interceptor = new MikroOrmInterceptor(
      {} as unknown as MikroORM,
      {} as unknown as ClsService,
      silentLogger
    );
    expect(interceptor.requestScoped).toBe(true);
  });

  it("carries no interceptConnect today → the real UoW wiring passes the connect-safety boot-assert", () => {
    // The marker is the belt to the suspenders: the UoW is already excluded from the connect chain by
    // having no interceptConnect (ADR 0022). Prove the guard does not false-positive on the real thing.
    const interceptor = new MikroOrmInterceptor(
      {} as unknown as MikroORM,
      {} as unknown as ClsService,
      silentLogger
    );
    expect(() => assertConnectInterceptorsSafe([interceptor])).not.toThrow();
  });
});
