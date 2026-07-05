import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { App, Module } from "@spinejs/core";
import type { Logger, ModuleEntry } from "@spinejs/core";
import { MikroORM, EntitySchema } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { ClsService, ClsInterceptor, ClsModule } from "@spinejs/cls";
import type { DispatchTarget, GatewayContext } from "@spinejs/gateway-core";
import {
  MikroOrmModule,
  MikroOrmInterceptor,
  mikroOrmRef,
  mikroOrmInterceptorRef,
} from "./index";

// --- Two independent connections, each its own entity + in-memory DB (each `:memory:` is distinct) ---
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

class AuditLog {
  id!: number;
  message!: string;
}
const AuditLogSchema = new EntitySchema<AuditLog>({
  class: AuditLog,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    message: { type: "string" },
  },
});

const AUDIT = "audit";

interface Captured {
  cls: ClsService;
  primary: MikroORM;
  audit: MikroORM;
  primaryInterceptor: MikroOrmInterceptor;
  auditInterceptor: MikroOrmInterceptor;
}
let captured: Captured | undefined;

// Captures the wired instances of BOTH connections: the default (class tokens) and the named "audit"
// (its refs). Importing the default `MikroOrmModule` and the audit connection node exposes both.
const makeCapture = (auditNode: ModuleEntry) => {
  @Module({
    inject: [
      ClsService,
      MikroORM,
      mikroOrmRef(AUDIT),
      MikroOrmInterceptor,
      mikroOrmInterceptorRef(AUDIT),
    ],
    imports: [ClsModule, MikroOrmModule, auditNode],
  })
  class CaptureModule {
    constructor(
      cls: ClsService,
      primary: MikroORM,
      audit: MikroORM,
      primaryInterceptor: MikroOrmInterceptor,
      auditInterceptor: MikroOrmInterceptor
    ) {
      captured = {
        cls,
        primary,
        audit,
        primaryInterceptor,
        auditInterceptor,
      };
    }
  }
  return CaptureModule;
};

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

// App installs process-level handlers at construction; snapshot + restore so a failing test cannot leave
// a handler that kills the vitest worker (mirrors core's app.spec / the integration spec).
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

const target: DispatchTarget<GatewayContext> = {
  guards: [],
  invoke: () => undefined,
};
const ctx: GatewayContext = {};

// A full dispatch through BOTH connections' interceptors (order: CLS scope → primary → audit → handler).
const dispatchBoth = (
  cap: Captured,
  handler: () => Promise<void>
): Promise<{ ok: boolean }> => {
  const cls = new ClsInterceptor(cap.cls);
  return cls.intercept(target, ctx, undefined, () =>
    cap.primaryInterceptor.intercept(target, ctx, undefined, () =>
      cap.auditInterceptor.intercept(target, ctx, undefined, async () => {
        await handler();
        return { ok: true, data: undefined };
      })
    )
  );
};

const buildApp = (opts: { multiWrite?: boolean } = {}) => {
  const auditNode = MikroOrmModule.configure({
    driver: BetterSqliteDriver,
    dbName: ":memory:",
    entities: [AuditLogSchema],
    name: AUDIT,
    multiWrite: opts.multiWrite,
  });
  return makeApp([
    MikroOrmModule.configure({
      driver: BetterSqliteDriver,
      dbName: ":memory:",
      entities: [AccountSchema],
      // Cross-DB writes are best-effort and order-coupled; the intuitive, order-independent path is to
      // opt in EVERY connection that participates. So the "allows" case marks both.
      multiWrite: opts.multiWrite,
    }),
    auditNode,
    makeCapture(auditNode),
  ]);
};

describe("MikroOrmModule multiple connections (ADR 0016, Amendment 1)", () => {
  it("opens both connections on start and closes both on stop, isolating each request's forks", async () => {
    const app = buildApp();
    await app.init();
    await app.start();
    const cap = captured!;

    expect(await cap.primary.isConnected()).toBe(true);
    expect(await cap.audit.isConnected()).toBe(true);
    expect(cap.primary).not.toBe(cap.audit);
    await cap.primary.schema.createSchema();
    await cap.audit.schema.createSchema();

    // Each connection resolves its OWN request fork — never each other's.
    await dispatchBoth(cap, async () => {
      const primaryFork = cap.primary.em.getContext();
      const auditFork = cap.audit.em.getContext();
      expect(primaryFork).not.toBe(auditFork);
    });

    await app.stop();
    expect(await cap.primary.isConnected()).toBe(false);
    expect(await cap.audit.isConnected()).toBe(false);
  });

  it("commits a write to ONE connection and leaves the other untouched (per-connection UoW)", async () => {
    const app = buildApp();
    await app.init();
    await app.start();
    const cap = captured!;
    await cap.primary.schema.createSchema();
    await cap.audit.schema.createSchema();

    // Write only the primary connection in this request.
    await dispatchBoth(cap, async () => {
      const em = cap.primary.em.getContext();
      em.persist(em.create(Account, { balance: 100 }));
    });

    let accounts: number | undefined;
    let audits: number | undefined;
    await dispatchBoth(cap, async () => {
      accounts = await cap.primary.em.getContext().count(Account, {});
      audits = await cap.audit.em.getContext().count(AuditLog, {});
    });
    expect(accounts).toBe(1);
    expect(audits).toBe(0); // the audit connection opened no transaction, wrote nothing
  });

  it("THROWS when a second connection is written in one request without multiWrite (write-once guard)", async () => {
    const app = buildApp(); // audit NOT multiWrite
    await app.init();
    await app.start();
    const cap = captured!;
    await cap.primary.schema.createSchema();
    await cap.audit.schema.createSchema();

    // Writing BOTH connections in one request: the second (inner) interceptor to flush hits the guard.
    await expect(
      dispatchBoth(cap, async () => {
        const p = cap.primary.em.getContext();
        p.persist(p.create(Account, { balance: 1 }));
        const a = cap.audit.em.getContext();
        a.persist(a.create(AuditLog, { message: "boom" }));
      })
    ).rejects.toThrow(/second connection was written/);
  });

  it("ALLOWS writing both connections when they opt into multiWrite (best-effort)", async () => {
    const app = buildApp({ multiWrite: true }); // both connections opt in
    await app.init();
    await app.start();
    const cap = captured!;
    await cap.primary.schema.createSchema();
    await cap.audit.schema.createSchema();

    // Both opted into multiWrite, so neither the first nor the second flush trips the write-once guard.
    const res = await dispatchBoth(cap, async () => {
      const p = cap.primary.em.getContext();
      p.persist(p.create(Account, { balance: 5 }));
      const a = cap.audit.em.getContext();
      a.persist(a.create(AuditLog, { message: "ok" }));
    });
    expect(res.ok).toBe(true);

    let accounts: number | undefined;
    let audits: number | undefined;
    await dispatchBoth(cap, async () => {
      accounts = await cap.primary.em.getContext().count(Account, {});
      audits = await cap.audit.em.getContext().count(AuditLog, {});
    });
    expect(accounts).toBe(1);
    expect(audits).toBe(1);
  });

  it("a named connection used without its interceptor stacked throws a wiring diagnostic (leak mitigation)", async () => {
    const app = buildApp();
    await app.init();
    await app.start();
    const cap = captured!;
    await cap.audit.schema.createSchema();

    // Open a CLS scope + the PRIMARY interceptor only (audit interceptor NOT stacked). Touching the audit
    // connection inside the scope must throw — its context hook refuses to fall back to the root manager.
    const cls = new ClsInterceptor(cap.cls);
    await expect(
      cls.intercept(target, ctx, undefined, () =>
        cap.primaryInterceptor.intercept(target, ctx, undefined, async () => {
          await cap.audit.em.getContext().count(AuditLog, {});
          return { ok: true, data: undefined };
        })
      )
    ).rejects.toThrow(/its interceptor is not stacked/);

    await app.stop();
  });
});
