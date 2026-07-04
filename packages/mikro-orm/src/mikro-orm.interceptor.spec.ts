import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MikroORM, EntityManager, EntitySchema } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { ClsService, ClsInterceptor } from "@spinejs/cls";
import type {
  DispatchTarget,
  Envelope,
  GatewayContext,
} from "@spinejs/gateway-core";
import { MikroOrmInterceptor } from "./mikro-orm.interceptor";
import { mikroOrmProvider, entityManagerProvider } from "./mikro-orm.module";
import { EM } from "./mikro-orm.options";

// --- Entity via EntitySchema (no decorators, ADR 0016 NFR1) --------------------------------------
class Widget {
  id!: number;
  name!: string;
}
const WidgetSchema = new EntitySchema<Widget>({
  class: Widget,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    name: { type: "string" },
  },
});

// A service holding ONLY the injected EntityManager — no manager threaded per call, no ctx argument.
// It uses `orm.em` (the root, provided by entityManagerProvider), which delegates each op to the
// current request's fork via getContext() — the differentiator (ADR 0016 §2).
class WidgetService {
  constructor(private readonly em: EntityManager) {}
  create(name: string): void {
    this.em.persist(this.em.create(Widget, { name } as Widget));
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
      entities: [WidgetSchema],
    });
    await orm.connect();
    await orm.schema.createSchema();
    clsInterceptor = new ClsInterceptor(cls);
    mikro = new MikroOrmInterceptor(orm, cls);
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

  it("must run inside a CLS scope — throws if used without ClsInterceptor", async () => {
    await expect(
      mikro.intercept(target, ctx, undefined, async () => ({
        ok: true,
        data: undefined,
      }))
    ).rejects.toThrow(/active scope/);
  });
});
