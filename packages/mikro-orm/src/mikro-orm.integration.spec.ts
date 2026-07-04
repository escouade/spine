import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { App, Injectable, Module } from "@spinejs/core";
import type { Logger, ModuleEntry } from "@spinejs/core";
import { MikroORM, EntitySchema, EntityRepository } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { ClsService, ClsInterceptor, ClsModule } from "@spinejs/cls";
import type {
  DispatchTarget,
  Envelope,
  GatewayContext,
} from "@spinejs/gateway-core";
import { MikroOrmModule, MikroOrmInterceptor } from "./index";

// --- Domain: entity + custom repository + service, wired through the real DI ----------------------
class User {
  id!: number;
  name!: string;
  email!: string;
}
class UserRepository extends EntityRepository<User> {
  findByEmail(email: string): Promise<User | null> {
    return this.findOne({ email });
  }
}
const UserSchema = new EntitySchema<User>({
  class: User,
  repository: () => UserRepository,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    name: { type: "string" },
    email: { type: "string" },
  },
});

@Injectable({ inject: [UserRepository] })
class UserService {
  constructor(private readonly users: UserRepository) {}
  add(name: string, email: string): void {
    const em = this.users.getEntityManager();
    em.persist(em.create(User, { name, email } as User));
  }
  findByEmail(email: string): Promise<User | null> {
    return this.users.findByEmail(email);
  }
  async rename(email: string, name: string): Promise<void> {
    const u = await this.users.findOneOrFail({ email });
    u.name = name; // no .save()
  }
}

// The feature module registers its repositories and captures the wired instances for the test to drive.
interface Captured {
  cls: ClsService;
  interceptor: MikroOrmInterceptor;
  service: UserService;
  orm: MikroORM;
}
let captured: Captured | undefined;

@Module({
  inject: [ClsService, MikroOrmInterceptor, UserService, MikroORM],
  // MikroOrmModule (bare) exposes the shared connection (MikroORM/EntityManager/interceptor);
  // register([...]) exposes THIS module's repository (UserRepository), isolated to it.
  imports: [
    ClsModule,
    MikroOrmModule,
    MikroOrmModule.register([UserRepository]),
  ],
  providers: [UserService],
})
class FeatureModule {
  constructor(
    cls: ClsService,
    interceptor: MikroOrmInterceptor,
    service: UserService,
    orm: MikroORM
  ) {
    captured = { cls, interceptor, service, orm };
  }
}

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

// App installs process-level error handlers at construction; snapshot + restore so a failing test
// cannot leave a handler that kills the vitest worker (mirrors core's app.spec).
const SIGNALS = [
  "uncaughtException",
  "unhandledRejection",
  "SIGINT",
  "SIGTERM",
] as const;
let listenerSnapshot: Record<string, ((...args: unknown[]) => void)[]>;

beforeEach(() => {
  captured = undefined;
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

describe("MikroOrmModule end-to-end through a real App (Story 1.6)", () => {
  const target: DispatchTarget<GatewayContext> = {
    guards: [],
    invoke: () => undefined,
  };
  const ctx: GatewayContext = {};

  // A full dispatch: ClsInterceptor opens the scope, then the wired MikroOrmInterceptor brackets it.
  const dispatchWith = (
    cap: Captured,
    handler: () => Promise<void>
  ): Promise<Envelope<unknown>> => {
    const clsInterceptor = new ClsInterceptor(cap.cls);
    return clsInterceptor.intercept(target, ctx, undefined, () =>
      cap.interceptor.intercept(target, ctx, undefined, async () => {
        await handler();
        return { ok: true, data: undefined };
      })
    );
  };

  it("opens the connection on start, injects a repository that persists without .save() (survives), and closes on stop", async () => {
    const app = makeApp([
      MikroOrmModule.configure({
        driver: BetterSqliteDriver,
        dbName: ":memory:",
        entities: [UserSchema],
      }),
      FeatureModule,
    ]);

    await app.init();
    await app.start();

    const cap = captured!;
    expect(cap).toBeDefined();
    expect(await cap.orm.isConnected()).toBe(true);
    await cap.orm.schema.createSchema();

    // Persist through the injected repository/service — no .save(), no manager threaded in.
    await dispatchWith(cap, async () => cap.service.add("alice", "a@x.io"));

    let found: User | null = null;
    await dispatchWith(cap, async () => {
      found = await cap.service.findByEmail("a@x.io");
    });
    expect(found).not.toBeNull();
    expect(found!.name).toBe("alice");

    await app.stop();
    expect(await cap.orm.isConnected()).toBe(false);
  });

  it("rolls back on error and isolates concurrent requests", async () => {
    const app = makeApp([
      MikroOrmModule.configure({
        driver: BetterSqliteDriver,
        dbName: ":memory:",
        entities: [UserSchema],
      }),
      FeatureModule,
    ]);
    await app.init();
    await app.start();
    const cap = captured!;
    await cap.orm.schema.createSchema();

    // Rollback: a throwing request persists nothing.
    await expect(
      dispatchWith(cap, async () => {
        cap.service.add("ghost", "g@x.io");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    let ghost: User | null = "x" as unknown as User;
    await dispatchWith(cap, async () => {
      ghost = await cap.service.findByEmail("g@x.io");
    });
    expect(ghost).toBeNull();

    // Concurrent isolation: each request sees its own fork across an await.
    const forks: unknown[] = [];
    const run = () =>
      dispatchWith(cap, async () => {
        const mine = cap.orm.em.getContext();
        await new Promise((r) => setTimeout(r, 10));
        expect(cap.orm.em.getContext()).toBe(mine);
        forks.push(mine);
      });
    await Promise.all([run(), run()]);
    expect(forks[0]).not.toBe(forks[1]);

    await app.stop();
  });

  it("retries a transient connection failure and starts (App lifecycle)", async () => {
    let attempts = 0;
    const flaky = {
      connect: () =>
        ++attempts < 3
          ? Promise.reject(new Error("db still booting"))
          : Promise.resolve(),
      close: () => Promise.resolve(),
      isConnected: async () => true,
    } as unknown as MikroORM;

    const app = makeApp([
      MikroOrmModule.configure({
        driver: BetterSqliteDriver,
        dbName: ":memory:",
        entities: [UserSchema],
        retry: { attempts: 5, delayMs: 1, backoff: 1 },
      }),
      // Override the constructed MikroORM with a controllable fake (merges by token into the node).
      {
        module: MikroOrmModule,
        providers: [{ provide: MikroORM, value: flaky }],
      },
    ]);

    await app.init();
    await expect(app.start()).resolves.toBeUndefined();
    expect(attempts).toBe(3);
    await app.stop();
  });

  it("aborts boot cleanly when the connection permanently fails past the retry budget", async () => {
    let attempts = 0;
    const failing = {
      connect: () => {
        attempts++;
        return Promise.reject(new Error("permanent db failure"));
      },
      close: () => Promise.resolve(),
    } as unknown as MikroORM;

    const app = makeApp([
      MikroOrmModule.configure({
        driver: BetterSqliteDriver,
        dbName: ":memory:",
        entities: [UserSchema],
        retry: { attempts: 2, delayMs: 1, backoff: 1 },
      }),
      {
        module: MikroOrmModule,
        providers: [{ provide: MikroORM, value: failing }],
      },
    ]);

    await app.init();
    await expect(app.start()).rejects.toThrow("permanent db failure");
    expect(attempts).toBe(2); // tried exactly the budget, then aborted
  });
});

// BUG 2: register() must isolate repos per importing module. Two entities, each with its own repo.
class EntityA {
  id!: number;
  a!: string;
}
class RepoA extends EntityRepository<EntityA> {}
const SchemaA = new EntitySchema<EntityA>({
  class: EntityA,
  repository: () => RepoA,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    a: { type: "string" },
  },
});

class EntityB {
  id!: number;
  b!: string;
}
class RepoB extends EntityRepository<EntityB> {}
const SchemaB = new EntitySchema<EntityB>({
  class: EntityB,
  repository: () => RepoB,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    b: { type: "string" },
  },
});

let capturedRepos: { a?: RepoA; b?: RepoB } = {};

@Module({ inject: [RepoA], imports: [MikroOrmModule.register([RepoA])] })
class ModuleA {
  constructor(a: RepoA) {
    capturedRepos.a = a;
  }
}

@Module({ inject: [RepoB], imports: [MikroOrmModule.register([RepoB])] })
class ModuleB {
  constructor(b: RepoB) {
    capturedRepos.b = b;
  }
}

const configureBoth = () =>
  MikroOrmModule.configure({
    driver: BetterSqliteDriver,
    dbName: ":memory:",
    entities: [SchemaA, SchemaB],
  });

describe("register() feature isolation (BUG 2)", () => {
  it("each module resolves its own registered repository (connection still shared)", async () => {
    capturedRepos = {};
    const app = makeApp([configureBoth(), ModuleA, ModuleB]);

    await app.init();
    await app.start();

    expect(capturedRepos.a).toBeInstanceOf(RepoA);
    expect(capturedRepos.b).toBeInstanceOf(RepoB);

    await app.stop();
  });

  it("a module CANNOT inject a repository another module registered", async () => {
    // ModuleB registers RepoB in its own isolated node; this module imports only RepoA's registration
    // but tries to inject RepoB — with isolation, RepoB must be an Unknown provider here.
    @Module({ inject: [RepoB], imports: [MikroOrmModule.register([RepoA])] })
    class LeakyModule {
      constructor(_b: RepoB) {}
    }

    const app = makeApp([configureBoth(), ModuleB, LeakyModule]);

    await expect(app.init()).rejects.toThrow(/Unknown provider/);
  });
});
