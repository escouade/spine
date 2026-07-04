import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MikroORM,
  EntityManager,
  EntitySchema,
  type Options,
} from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { ClsService } from "@spinejs/cls";
import type { Logger } from "@spinejs/core";
import {
  MikroOrmModule,
  MikroOrmInterceptor,
  DEFAULT_RETRY,
  connectWithRetry,
  mikroOrmProvider,
  entityManagerProvider,
} from "./index";
import {
  mikroOrmOptionsToken,
  retryPolicyToken,
  type RetryPolicy,
} from "./mikro-orm.options";

// --- Entity via EntitySchema (no decorators — the portable style, ADR 0016 NFR1) -----------------
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

const baseOptions = (): Options =>
  ({
    driver: BetterSqliteDriver,
    dbName: ":memory:",
    entities: [WidgetSchema],
  } as Options);

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;

// Builds the real MikroORM through the shipped factory (constructed, not yet connected).
const buildOrm = (cls = new ClsService()): MikroORM =>
  mikroOrmProvider.factory(cls, baseOptions());

describe("MikroOrmModule — lifecycle + startup retry (Story 1.2)", () => {
  describe("configure()", () => {
    it("wires the providers and exports and targets MikroOrmModule", () => {
      const dyn = MikroOrmModule.configure(baseOptions());
      expect(dyn.module).toBe(MikroOrmModule);

      // Providers are either `{ provide }` objects or bare classes (the interceptor); normalize both.
      const tokens = (dyn.providers ?? []).map((p) =>
        typeof p === "function" ? p : (p as { provide: unknown }).provide
      );
      expect(tokens).toContain(MikroORM);
      expect(tokens).toContain(EntityManager);
      expect(tokens).toContain(mikroOrmOptionsToken);
      expect(tokens).toContain(retryPolicyToken);
      expect(tokens).toContain(MikroOrmInterceptor);

      expect(dyn.exports).toContain(MikroORM);
      expect(dyn.exports).toContain(EntityManager);
      expect(dyn.exports).toContain(MikroOrmInterceptor);
    });

    it("applies the default retry policy when none is given", () => {
      const dyn = MikroOrmModule.configure(baseOptions());
      const rp = (dyn.providers ?? []).find(
        (p) => (p as { provide: unknown }).provide === retryPolicyToken
      ) as { value: RetryPolicy };
      expect(rp.value).toEqual(DEFAULT_RETRY);
    });

    it("merges a partial retry over the defaults and strips retry from the ORM options", () => {
      const dyn = MikroOrmModule.configure({
        ...baseOptions(),
        retry: { attempts: 9 },
      });

      const rp = (dyn.providers ?? []).find(
        (p) => (p as { provide: unknown }).provide === retryPolicyToken
      ) as { value: RetryPolicy };
      expect(rp.value).toEqual({ ...DEFAULT_RETRY, attempts: 9 });

      const opts = (dyn.providers ?? []).find(
        (p) => (p as { provide: unknown }).provide === mikroOrmOptionsToken
      ) as { value: Record<string, unknown> };
      expect("retry" in opts.value).toBe(false);
    });
  });

  describe("onStart / onStop against a real sqlite connection", () => {
    it("constructs the instance at build without connecting, then connects on onStart and closes on onStop", async () => {
      const orm = buildOrm();
      const connectSpy = vi.spyOn(orm, "connect");
      const closeSpy = vi.spyOn(orm, "close");

      const mod = new MikroOrmModule(orm, silentLogger, DEFAULT_RETRY);

      await mod.onStart();
      expect(connectSpy).toHaveBeenCalledTimes(1);

      // The connection is real and usable.
      await orm.schema.createSchema();
      expect(await orm.em.fork().count(Widget, {})).toBe(0);

      await mod.onStop();
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(await orm.isConnected()).toBe(false);
    });

    // BUG (E6): onStop pairs with onInit, so it also runs on a failed boot. Closing a never-connected
    // ORM must be a no-op — closing anyway could throw out of onStop and MASK the connection error.
    it("onStop does NOT close when the ORM never connected (boot abort must not be masked)", async () => {
      const connect = vi.fn().mockRejectedValue(new Error("no db"));
      const close = vi.fn().mockResolvedValue(undefined);
      const fakeOrm = { connect, close } as unknown as MikroORM;
      const retry: RetryPolicy = { attempts: 1, delayMs: 1, backoff: 1 };
      const mod = new MikroOrmModule(fakeOrm, silentLogger, retry);

      await expect(mod.onStart()).rejects.toThrow("no db"); // boot abort
      await expect(mod.onStop()).resolves.toBeUndefined();
      expect(close).not.toHaveBeenCalled(); // nothing to close, error not masked
    });

    // A close() failure on the connected path must be logged, never thrown out of onStop — otherwise it
    // aborts the rest of shutdown (other modules' onStop).
    it("onStop never lets a close() failure escape", async () => {
      const connect = vi.fn().mockResolvedValue(undefined);
      const close = vi.fn().mockRejectedValue(new Error("close failed"));
      const fakeOrm = { connect, close } as unknown as MikroORM;
      const mod = new MikroOrmModule(fakeOrm, silentLogger, DEFAULT_RETRY);

      await mod.onStart(); // connected = true
      await expect(mod.onStop()).resolves.toBeUndefined(); // swallowed + logged, not thrown
      expect(close).toHaveBeenCalledTimes(1);
    });
  });

  describe("retry (fake connect to control transient/permanent failure)", () => {
    it("retries a transient connect failure with backoff, then succeeds", async () => {
      const connect = vi
        .fn()
        .mockRejectedValueOnce(new Error("db booting"))
        .mockRejectedValueOnce(new Error("db booting"))
        .mockResolvedValue(undefined);
      const fakeOrm = { connect, close: vi.fn() } as unknown as MikroORM;
      const retry: RetryPolicy = { attempts: 5, delayMs: 1, backoff: 2 };

      const mod = new MikroOrmModule(fakeOrm, silentLogger, retry);
      await expect(mod.onStart()).resolves.toBeUndefined();
      expect(connect).toHaveBeenCalledTimes(3);
    });

    it("throws after the retry budget is exhausted (clean boot abort), having tried exactly `attempts` times", async () => {
      const connect = vi.fn().mockRejectedValue(new Error("no db"));
      const fakeOrm = { connect, close: vi.fn() } as unknown as MikroORM;
      const retry: RetryPolicy = { attempts: 3, delayMs: 1, backoff: 1 };

      const mod = new MikroOrmModule(fakeOrm, silentLogger, retry);
      await expect(mod.onStart()).rejects.toThrow("no db");
      expect(connect).toHaveBeenCalledTimes(3);
    });

    it("connectWithRetry succeeds on the first attempt when connect resolves immediately", async () => {
      const connect = vi.fn().mockResolvedValue(undefined);
      const fakeOrm = { connect } as unknown as MikroORM;
      await connectWithRetry(fakeOrm, DEFAULT_RETRY);
      expect(connect).toHaveBeenCalledTimes(1);
    });

    // BUG 3: a NaN/fractional/≤0 `attempts` must NOT silently resolve without connecting — that boots a
    // "healthy" app whose first query fails. It must make at least one real attempt (connect, or throw).
    it("attempts=NaN behaves as one real attempt (throws, never silent-resolves)", async () => {
      const connect = vi.fn().mockRejectedValue(new Error("no db"));
      const fakeOrm = { connect, close: vi.fn() } as unknown as MikroORM;
      const retry = { attempts: NaN, delayMs: 1, backoff: 1 } as RetryPolicy;

      await expect(connectWithRetry(fakeOrm, retry)).rejects.toThrow("no db");
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it("attempts=NaN connects once when the DB is up (does not skip the connect)", async () => {
      const connect = vi.fn().mockResolvedValue(undefined);
      const fakeOrm = { connect } as unknown as MikroORM;
      const retry = { attempts: NaN, delayMs: 1, backoff: 1 } as RetryPolicy;

      await connectWithRetry(fakeOrm, retry);
      expect(connect).toHaveBeenCalledTimes(1);
    });

    it("fractional attempts floor to whole retries (2.9 → 2 attempts)", async () => {
      const connect = vi.fn().mockRejectedValue(new Error("no db"));
      const fakeOrm = { connect, close: vi.fn() } as unknown as MikroORM;
      const retry = { attempts: 2.9, delayMs: 1, backoff: 1 } as RetryPolicy;

      await expect(connectWithRetry(fakeOrm, retry)).rejects.toThrow("no db");
      expect(connect).toHaveBeenCalledTimes(2);
    });

    // BUG (P4): a NaN delayMs/backoff must be coerced to a finite delay — otherwise setTimeout(NaN)
    // fires ~immediately and the backoff silently collapses exactly when the DB needs breathing room.
    it("coerces NaN delayMs/backoff to the default (never schedules setTimeout(NaN))", async () => {
      const connect = vi
        .fn()
        .mockRejectedValueOnce(new Error("db booting"))
        .mockResolvedValue(undefined);
      const fakeOrm = { connect } as unknown as MikroORM;
      const retry = { attempts: 3, delayMs: NaN, backoff: NaN } as RetryPolicy;

      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        await connectWithRetry(fakeOrm, retry);
        expect(connect).toHaveBeenCalledTimes(2); // retried the transient failure, then succeeded
        const delays = setTimeoutSpy.mock.calls.map((c) => c[1]);
        expect(delays.every((d) => Number.isFinite(d))).toBe(true);
        expect(delays).toContain(DEFAULT_RETRY.delayMs);
      } finally {
        setTimeoutSpy.mockRestore();
      }
    });
  });
});

describe("entityManagerProvider (Story 1.2 wiring)", () => {
  let orm: MikroORM;
  beforeEach(async () => {
    orm = buildOrm();
    await orm.connect();
  });
  afterEach(async () => {
    await orm.close(true);
  });

  it("provides orm.em (the root manager) as the injectable EntityManager", () => {
    expect(entityManagerProvider.factory(orm)).toBe(orm.em);
  });
});
