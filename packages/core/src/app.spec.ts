import { vi } from "vitest";
import type { Logger } from "./logger";
import { App, appToken, loggerToken } from "./app";
import { ModuleNode } from "./module";
import type { DynamicModule, ModuleEntry } from "./module";
import { InjectionToken } from "./container";

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;

const makeApp = (modules: ModuleEntry[]) =>
  new App(modules, { logger: silentLogger, handleProcessExit: false });

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `App` installs process-level error handlers (uncaughtException / unhandledRejection)
// that call process.exit — which would kill the Jest worker. We snapshot the process
// listeners before each test and remove any the App added afterwards.
const SIGNALS = [
  "uncaughtException",
  "unhandledRejection",
  "SIGINT",
  "SIGTERM",
] as const;

let listenerSnapshot: Record<string, ((...args: unknown[]) => void)[]>;

beforeEach(() => {
  listenerSnapshot = {};
  for (const signal of SIGNALS) {
    listenerSnapshot[signal] = process
      .listeners(signal as NodeJS.Signals)
      .slice() as never;
  }
});

afterEach(() => {
  for (const signal of SIGNALS) {
    for (const listener of process.listeners(signal as NodeJS.Signals)) {
      if (!listenerSnapshot[signal].includes(listener as never)) {
        process.removeListener(signal as NodeJS.Signals, listener as never);
      }
    }
  }
});

describe("App / module system", () => {
  it("injects the appToken and loggerToken into a module constructor", async () => {
    let captured: { app: unknown; logger: unknown } | undefined;

    class RootModule {
      constructor(
        public readonly app: unknown,
        public readonly logger: unknown
      ) {}
      onInit() {
        captured = { app: this.app, logger: this.logger };
      }
    }

    const app = makeApp([
      new ModuleNode({ module: RootModule, inject: [appToken, loggerToken] }),
    ]);
    await app.init();

    expect(captured?.app).toBe(app);
    expect(captured?.logger).toBe(silentLogger);
  });

  it("runs onInit() for every module in the graph", async () => {
    const inited = new Set<string>();

    class Leaf {
      onInit() {
        inited.add("leaf");
      }
    }
    const leaf = new ModuleNode({ module: Leaf });

    class Root {
      onInit() {
        inited.add("root");
      }
    }
    const root = new ModuleNode({ module: Root, imports: [leaf] });

    await makeApp([root]).init();

    expect(inited).toEqual(new Set(["leaf", "root"]));
  });

  it("inits an imported module before constructing the importer (injected deps are ready)", async () => {
    const order: string[] = [];

    // Simule un module qui fait de l'IO (config, BDD) dans son onInit().
    class Db {
      ready = false;
      async onInit() {
        await delay(5);
        this.ready = true;
        order.push("db:init");
      }
    }
    const dbProvider = new ModuleNode({ module: Db });

    let dbReadyAtConstruction: boolean | undefined;
    class Api {
      constructor(db: Db) {
        order.push("api:construct");
        // The injected dependency has already run its onInit(): it is ready, not just constructed.
        dbReadyAtConstruction = db.ready;
      }
    }
    const apiProvider = new ModuleNode({
      module: Api,
      imports: [dbProvider],
      inject: [Db],
    });

    await makeApp([apiProvider]).init();

    expect(order).toEqual(["db:init", "api:construct"]);
    expect(dbReadyAtConstruction).toBe(true);
  });

  it("resolves sibling imports concurrently, not serially", async () => {
    const events: string[] = [];

    class Slow {
      async onInit() {
        events.push("slow:start");
        await delay(20);
        events.push("slow:end");
      }
    }
    const slow = new ModuleNode({ module: Slow });

    class Fast {
      async onInit() {
        events.push("fast:start");
        await delay(1);
        events.push("fast:end");
      }
    }
    const fast = new ModuleNode({ module: Fast });

    class Root {}
    const root = new ModuleNode({ module: Root, imports: [slow, fast] });

    await makeApp([root]).init();

    // Fast starts before Slow finishes → siblings do not serialize.
    expect(events.indexOf("fast:start")).toBeLessThan(
      events.indexOf("slow:end")
    );
  });

  it("awaits asynchronous module onInit()", async () => {
    let done = false;

    class AsyncModule {
      async onInit() {
        await delay(5);
        done = true;
      }
    }

    await makeApp([new ModuleNode({ module: AsyncModule })]).init();
    expect(done).toBe(true);
  });

  it("exposes a module's exported providers to importing modules", async () => {
    const greetingToken = new InjectionToken<string>("greeting");

    class GreetingModule {}
    const greetingModule = new ModuleNode({
      module: GreetingModule,
      providers: [{ provide: greetingToken, value: "hello" }],
      exports: [greetingToken],
    });

    let received: string | undefined;
    class ConsumerModule {
      constructor(greeting: string) {
        received = greeting;
      }
    }
    const consumer = new ModuleNode({
      module: ConsumerModule,
      imports: [greetingModule],
      inject: [greetingToken],
    });

    await makeApp([consumer]).init();
    expect(received).toBe("hello");
  });

  it("injects an imported module instance by its class (same shared instance)", async () => {
    class Source {
      value = 0;
    }
    const sourceProvider = new ModuleNode({ module: Source });

    class ListenerModule {
      constructor(public readonly src: Source) {}
    }
    const listenerProvider = new ModuleNode({
      module: ListenerModule,
      imports: [sourceProvider],
      inject: [Source],
    });

    // Probe module: retrieves both instances by injection (without aliasing `this`).
    let source: Source | undefined;
    let listener: ListenerModule | undefined;
    class Probe {
      constructor(src: Source, listenerModule: ListenerModule) {
        source = src;
        listener = listenerModule;
      }
    }
    const probeProvider = new ModuleNode({
      module: Probe,
      imports: [sourceProvider, listenerProvider],
      inject: [Source, ListenerModule],
    });

    await makeApp([probeProvider]).init();

    // The listener did receive the same Source instance as the one injected into the probe.
    expect(listener?.src).toBe(source);
  });

  it("runs onStart() hooks after init, in init order", async () => {
    const order: string[] = [];

    class Leaf {
      onInit() {
        order.push("leaf:init");
      }
      onStart() {
        order.push("leaf:start");
      }
    }
    const leaf = new ModuleNode({ module: Leaf });

    class Root {
      onStart() {
        order.push("root:start");
      }
    }
    const root = new ModuleNode({ module: Root, imports: [leaf] });

    const app = makeApp([root]);
    await app.init();
    await app.start();

    // onStart runs after everything is initialized, dependency before importer.
    expect(order).toEqual(["leaf:init", "leaf:start", "root:start"]);
  });

  it("builds a shared module only once, even across concurrent branches", async () => {
    let constructed = 0;
    let initialized = 0;
    let fromLeft!: Shared;
    let fromRight!: Shared;

    class Shared {
      constructor() {
        constructed++;
      }
      async onInit() {
        await delay(5);
        initialized++;
      }
    }
    const shared = new ModuleNode({ module: Shared });

    class Left {
      constructor(public readonly shared: Shared) {
        fromLeft = shared;
      }
    }
    const left = new ModuleNode({
      module: Left,
      imports: [shared],
      inject: [Shared],
    });

    class Right {
      constructor(public readonly shared: Shared) {
        fromRight = shared;
      }
    }
    const right = new ModuleNode({
      module: Right,
      imports: [shared],
      inject: [Shared],
    });

    // `Left` and `Right` both import `Shared` → it must be built and inited exactly once.
    await makeApp([left, right]).init();

    expect(constructed).toBe(1);
    expect(initialized).toBe(1);
    expect(fromLeft).toBe(fromRight);
  });

  it("throws on circular module imports", async () => {
    class A {}
    class B {}

    const a = new ModuleNode({ module: A, imports: [] });
    const b = new ModuleNode({ module: B, imports: [a] });
    a.imports!.push(b); // A imports B, B imports A

    await expect(makeApp([a]).init()).rejects.toThrow(
      /Circular dependency between modules/
    );
  });

  it("detects a cycle even when both ends are imported by a common ancestor (no deadlock)", async () => {
    // root → [A, B], A ↔ B. Order-dependent detection used to miss this and deadlock.
    class A {}
    class B {}
    const a = new ModuleNode({ module: A, imports: [] });
    const b = new ModuleNode({ module: B, imports: [a] });
    a.imports!.push(b);

    class Root {}
    const root = new ModuleNode({ module: Root, imports: [a, b] });

    await expect(makeApp([root]).init()).rejects.toThrow(
      /Circular dependency between modules/
    );
  });

  it("resolves a diamond (shared dependency, no cycle) without a false positive", async () => {
    let cBuilt = 0;
    class C {
      constructor() {
        cBuilt++;
      }
    }
    const c = new ModuleNode({ module: C });
    const left = new ModuleNode({ module: class Left {}, imports: [c] });
    const right = new ModuleNode({ module: class Right {}, imports: [c] });
    const root = new ModuleNode({
      module: class Root {},
      imports: [left, right],
    });

    await makeApp([root]).init();

    expect(cBuilt).toBe(1);
  });

  it("addProviders: the overriding value is the one injected into the module", async () => {
    const cfgToken = new InjectionToken<string>("test:cfg");

    let seen: string | undefined;
    class Configured {
      constructor(cfg: string) {
        seen = cfg;
      }
    }

    const p = new ModuleNode({
      module: Configured,
      inject: [cfgToken],
      providers: [{ provide: cfgToken, value: "default" }],
    });
    // Upsert: must override the default, not be ignored by the Container's "first wins".
    p.addProviders([{ provide: cfgToken, value: "overridden" }]);

    await makeApp([p]).init();

    expect(seen).toBe("overridden");
  });

  it("runs onStop() hooks in reverse order on stop", async () => {
    const order: string[] = [];

    class Leaf {
      onStop() {
        order.push("leaf");
      }
    }
    const leaf = new ModuleNode({ module: Leaf });

    class Root {
      onStop() {
        order.push("root");
      }
    }
    const root = new ModuleNode({ module: Root, imports: [leaf] });

    const app = makeApp([root]);
    await app.init();
    await app.stop();

    // Root (importer) resolved after Leaf → stops before it (reverse order).
    expect(order).toEqual(["root", "leaf"]);
  });

  it("runs the shutdown only once even if exit() is triggered twice", async () => {
    let stopped = 0;
    class Mod {
      onStop() {
        stopped++;
      }
    }

    const app = makeApp([new ModuleNode({ module: Mod })]);
    await app.init();

    // process.exit must be mocked: otherwise it would kill the Jest worker and never return.
    // External counter: mockRestore() clears the spy history, we can't assert it afterwards.
    let exitCalls = 0;
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => void exitCalls++) as never);
    try {
      await app.exit();
      await app.exit(); // 2nd trigger (duplicated signal / re-fire): must short-circuit.
    } finally {
      exitSpy.mockRestore();
    }

    expect(stopped).toBe(1);
    expect(exitCalls).toBe(1);
  });

  it("force-exits once onStop() hangs past shutdownTimeout", async () => {
    class HangingMod {
      onStop() {
        return new Promise<void>(() => {}); // never resolves
      }
    }

    const app = new App([new ModuleNode({ module: HangingMod })], {
      logger: silentLogger,
      handleProcessExit: false,
      shutdownTimeout: 20,
    });
    await app.init();

    let exitCalls = 0;
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => void exitCalls++) as never);
    try {
      // Not awaited: with a hung onStop() and process.exit() mocked, exit() never resolves.
      // The hardKill timer is the only path that fires — give it past shutdownTimeout.
      void app.exit();
      await delay(50);
    } finally {
      exitSpy.mockRestore();
    }

    expect(exitCalls).toBe(1);
  });

  it("fresh: a configured module yields a distinct instance per configure() call", async () => {
    let instances = 0;
    class Db {
      constructor() {
        instances++;
      }
    }
    // Distinct export token per connection name (the way to inject a fresh module).
    // Memoized: tokens match by identity, so provide/export/inject must share the SAME instance.
    const dbTokens = new Map<string, InjectionToken<string>>();
    const dbConn = (name: string) =>
      dbTokens.get(name) ??
      dbTokens
        .set(name, new InjectionToken<string>(`db.conn.${name}`))
        .get(name)!;
    const configure = (name: string): DynamicModule => ({
      module: Db,
      fresh: true,
      providers: [{ provide: dbConn(name), factory: () => `conn:${name}` }],
      exports: [dbConn(name)],
    });

    let main: string | undefined;
    let replica: string | undefined;
    class UsesMain {
      constructor(conn: string) {
        main = conn;
      }
    }
    class UsesReplica {
      constructor(conn: string) {
        replica = conn;
      }
    }

    const usesMain = new ModuleNode({
      module: UsesMain,
      imports: [configure("main")],
      inject: [dbConn("main")],
    });
    const usesReplica = new ModuleNode({
      module: UsesReplica,
      imports: [configure("replica")],
      inject: [dbConn("replica")],
    });

    await makeApp([usesMain, usesReplica]).init();

    // Two distinct configure() → two Db instances, each with its scoped connection.
    expect(instances).toBe(2);
    expect(main).toBe("conn:main");
    expect(replica).toBe("conn:replica");
  });

  it("fresh: the same DynamicModule object imported twice is shared (diamond)", async () => {
    let instances = 0;
    class Db {
      constructor() {
        instances++;
      }
    }
    const token = new InjectionToken<string>("db.shared");
    // A single DynamicModule object → shared identity even when imported by two consumers.
    const shared: DynamicModule = {
      module: Db,
      fresh: true,
      providers: [{ provide: token, value: "shared-conn" }],
      exports: [token],
    };

    class Left {
      constructor(public readonly conn: string) {}
    }
    class Right {
      constructor(public readonly conn: string) {}
    }
    const left = new ModuleNode({
      module: Left,
      imports: [shared],
      inject: [token],
    });
    const right = new ModuleNode({
      module: Right,
      imports: [shared],
      inject: [token],
    });

    await makeApp([left, right]).init();

    expect(instances).toBe(1);
  });

  it("builds imports added by a later dynamic occurrence of an already-seen module (#3)", async () => {
    const initialized = new Set<string>();
    class Extra {
      onInit() {
        initialized.add("extra");
      }
    }
    const extra = new ModuleNode({ module: Extra });

    class Shared {}

    // 1er root : importe Shared en classe nue (Shared vu en premier).
    const rootA = new ModuleNode({ module: class RootA {}, imports: [Shared] });
    // 2e root : importe Shared en DynamicModule qui AJOUTE un import (extra).
    const rootB = new ModuleNode({
      module: class RootB {},
      imports: [{ module: Shared, imports: [extra] }],
    });

    // Before the fix: "Extra missing from cache" because the 2nd occurrence was not re-walked.
    await makeApp([rootA, rootB]).init();

    expect(initialized.has("extra")).toBe(true);
  });

  it("throws when injecting a fresh module by its class (use its exported token instead)", async () => {
    class Db {}
    const dbProvider: DynamicModule = { module: Db, fresh: true };

    class Consumer {
      constructor(public readonly db: Db) {}
    }
    const consumer = new ModuleNode({
      module: Consumer,
      imports: [dbProvider],
      inject: [Db],
    });

    await expect(makeApp([consumer]).init()).rejects.toThrow(
      /Unknown provider/
    );
  });

  it("on init() failure, stops the modules that did initialize, then rejects (atomic)", async () => {
    const events: string[] = [];
    class Leaf {
      onInit() {
        events.push("leaf:init");
      }
      onStop() {
        events.push("leaf:stop");
      }
    }
    const leaf = new ModuleNode({ module: Leaf });

    class Boom {
      onInit() {
        throw new Error("boom");
      }
    }
    const boom = new ModuleNode({ module: Boom, imports: [leaf] });

    const app = makeApp([boom]);
    await expect(app.init()).rejects.toThrow(/boom/);
    // Leaf was initialized then stopped by the atomic cleanup of init().
    expect(events).toEqual(["leaf:init", "leaf:stop"]);

    // stop() est idempotent : un 2e appel ne re-stoppe pas.
    await app.stop();
    expect(events).toEqual(["leaf:init", "leaf:stop"]);
  });

  it("start() is idempotent and refuses to start after stop()", async () => {
    let starts = 0;
    class Mod {
      onStart() {
        starts++;
      }
    }

    const app = makeApp([new ModuleNode({ module: Mod })]);
    await app.init();
    await app.start();
    await app.start(); // second call: no-op, onStart must not fire again.
    expect(starts).toBe(1);

    await app.stop();
    // Modules are torn down → restarting would fire onStart on dead instances.
    await expect(app.start()).rejects.toThrow(/Cannot start a stopped App/);
    expect(starts).toBe(1);
  });

  it("detaches its process-level listeners on stop (no leak across instances)", async () => {
    const baseline = {
      uncaughtException: process.listenerCount("uncaughtException"),
      unhandledRejection: process.listenerCount("unhandledRejection"),
    };

    const app = makeApp([new ModuleNode({ module: class Mod {} })]);
    await app.init();

    // Constructor attached one handler each.
    expect(process.listenerCount("uncaughtException")).toBe(
      baseline.uncaughtException + 1
    );
    expect(process.listenerCount("unhandledRejection")).toBe(
      baseline.unhandledRejection + 1
    );

    await app.stop();

    // stop() released them → back to baseline, nothing left firing on a dead App.
    expect(process.listenerCount("uncaughtException")).toBe(
      baseline.uncaughtException
    );
    expect(process.listenerCount("unhandledRejection")).toBe(
      baseline.unhandledRejection
    );
  });

  it("on start() failure, stops every initialized module, then rejects (atomic)", async () => {
    const events: string[] = [];
    class Leaf {
      onStart() {
        events.push("leaf:start");
      }
      onStop() {
        events.push("leaf:stop");
      }
    }
    const leaf = new ModuleNode({ module: Leaf });

    class Boom {
      onStart() {
        throw new Error("start-boom");
      }
      onStop() {
        events.push("boom:stop");
      }
    }
    // Boom imports Leaf → Leaf starts first (init order), then Boom's onStart throws.
    const boom = new ModuleNode({ module: Boom, imports: [leaf] });

    const app = makeApp([boom]);
    await app.init();
    await expect(app.start()).rejects.toThrow(/start-boom/);

    // Leaf started; Boom's failure triggers stop() → onStop in reverse order for every
    // initialized module (onStop pairs with onInit, regardless of whether onStart ran).
    expect(events).toEqual(["leaf:start", "boom:stop", "leaf:stop"]);

    // stop() is idempotent: the atomic cleanup already called it.
    await app.stop();
    expect(events).toEqual(["leaf:start", "boom:stop", "leaf:stop"]);
  });
});
