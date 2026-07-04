import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MikroORM, EntitySchema, EntityManager } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { ClsService, ClsInterceptor } from "@spinejs/cls";
import { DispatchPipeline } from "@spinejs/gateway-core";
import type {
  DispatchTarget,
  ErrorMapper,
  GatewayContext,
  Validator,
} from "@spinejs/gateway-core";
import { MikroOrmInterceptor } from "./index";
import { mikroOrmProvider } from "./mikro-orm.module";

// Regression guard for BUG 1: the DispatchPipeline NEVER throws — a handler that throws comes back as
// `{ ok: false }`, so `next()` RESOLVES with an error envelope. The interceptor must roll back on that
// envelope; a naive `await next(); await commit()` would COMMIT every application error. This drives the
// REAL pipeline (not a hand-rolled next), which is exactly the path the earlier interceptor.spec missed.
class Account {
  id!: number;
  balance!: number;
}
const AccountSchema = new EntitySchema<Account>({
  class: Account,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    balance: { type: "number" },
  },
});

const passthroughValidator: Validator = {
  validate: (_schema, input) => input,
};
const messageErrorMapper: ErrorMapper = {
  toCode: (err) => (err instanceof Error ? err.message : "ERR"),
};

describe("MikroOrmInterceptor through the real DispatchPipeline (BUG 1 regression)", () => {
  let orm: MikroORM;
  let cls: ClsService;
  let pipeline: DispatchPipeline<GatewayContext>;

  const ctx: GatewayContext = {};

  const runDispatch = (
    invoke: (em: EntityManager) => Promise<void>
  ): Promise<{ ok: boolean }> => {
    const target: DispatchTarget<GatewayContext> = {
      guards: [],
      invoke: async () => {
        await invoke(orm.em.getContext());
      },
    };
    return pipeline.dispatch(target, ctx, undefined);
  };

  beforeEach(async () => {
    cls = new ClsService();
    orm = mikroOrmProvider.factory(
      cls,
      {
        driver: BetterSqliteDriver,
        dbName: ":memory:",
        entities: [AccountSchema],
      },
      undefined
    );
    await orm.connect();
    await orm.schema.createSchema();
    // ClsInterceptor (outermost, opens the scope) then MikroOrmInterceptor (forks + brackets the txn).
    pipeline = new DispatchPipeline<GatewayContext>(
      passthroughValidator,
      messageErrorMapper,
      [new ClsInterceptor(cls), new MikroOrmInterceptor(orm, cls)]
    );
  });

  afterEach(async () => {
    await orm.close(true);
  });

  it("ROLLS BACK when the handler throws a business error (pipeline returns {ok:false}, does not reject)", async () => {
    const res = await runDispatch(async (em) => {
      em.persist(em.create(Account, { balance: 100 } as Account));
      throw new Error("business rule violated"); // pipeline maps this to { ok: false }
    });

    // The dispatch resolves to an error envelope — the pipeline did not throw.
    expect(res.ok).toBe(false);

    // …and nothing was persisted: the unit-of-work was rolled back, not committed.
    let count: number | undefined;
    await runDispatch(async (em) => {
      count = await em.count(Account, {});
    });
    expect(count).toBe(0);
  });

  it("COMMITS on the success path", async () => {
    const res = await runDispatch(async (em) => {
      em.persist(em.create(Account, { balance: 42 } as Account));
    });
    expect(res.ok).toBe(true);

    let balance: number | undefined;
    await runDispatch(async (em) => {
      balance = (await em.findOne(Account, { id: 1 }))?.balance;
    });
    expect(balance).toBe(42);
  });
});
