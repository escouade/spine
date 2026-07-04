import { describe, it, expect } from "vitest";
import { EntitySchema, type LogContext } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { ClsService } from "@spinejs/cls";
import type { Logger } from "@spinejs/core";
import { mikroOrmProvider } from "./mikro-orm.module";
import { SpineMikroLogger } from "./mikro-orm.logger";

const ESC = String.fromCharCode(27); // ANSI escape introducer, e.g. `${ESC}[31m` … `${ESC}[39m`

class Note {
  id!: number;
  text!: string;
}
const NoteSchema = new EntitySchema<Note>({
  class: Note,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    text: { type: "string" },
  },
});

interface LogCall {
  level: string;
  message: string;
}
function makeFakeLogger(): { logger: Logger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  const rec =
    (level: string) =>
    (message: unknown): void => {
      calls.push({ level, message: String(message) });
    };
  const logger = {
    info: rec("info"),
    error: rec("error"),
    warn: rec("warn"),
    debug: rec("debug"),
    verbose: rec("verbose"),
    fatal: rec("fatal"),
    exit: async () => {},
  } as unknown as Logger;
  return { logger, calls };
}

const baseOptions = () => ({
  driver: BetterSqliteDriver,
  dbName: ":memory:",
  entities: [NoteSchema],
  debug: true,
});

describe("MikroORM logging bridge (Story 1.5)", () => {
  it("routes MikroORM log output through the injected spine logger (one sink), ANSI-stripped", async () => {
    const { logger, calls } = makeFakeLogger();
    const orm = mikroOrmProvider.factory(
      new ClsService(),
      baseOptions(),
      logger
    );
    await orm.connect();
    await orm.schema.createSchema();

    const em = orm.em.fork();
    await em.begin();
    em.persist(em.create(Note, { text: "hi" } as Note));
    await em.commit();
    await orm.close(true);

    const debug = calls
      .filter((c) => c.level === "debug")
      .map((c) => c.message);
    expect(debug.length).toBeGreaterThan(0);
    // At least one line is an actual SQL/connection event routed through the bridge.
    expect(
      debug.some((m) => /insert|select|begin|commit|discovery/i.test(m))
    ).toBe(true);
    // No ANSI color escape codes leak into the structured logger.
    expect(calls.every((c) => !c.message.includes(ESC))).toBe(true);
  });

  it("does not crash when no logger is available (graceful degradation)", async () => {
    const orm = mikroOrmProvider.factory(
      new ClsService(),
      { ...baseOptions(), debug: false },
      undefined
    );
    await orm.connect();
    await orm.schema.createSchema();

    await expect(
      (async () => {
        const em = orm.em.fork();
        await em.begin();
        em.persist(em.create(Note, { text: "hi" } as Note));
        await em.commit();
        await orm.close(true);
      })()
    ).resolves.toBeUndefined();
  });

  it("honors a user-provided logger option over the spine bridge", async () => {
    const userLines: string[] = [];
    const { logger, calls } = makeFakeLogger();
    const orm = mikroOrmProvider.factory(
      new ClsService(),
      { ...baseOptions(), logger: (m: string) => userLines.push(m) },
      logger
    );
    await orm.connect();
    await orm.close(true);

    expect(userLines.length).toBeGreaterThan(0); // MikroORM logged to the user's sink…
    expect(calls.filter((c) => c.level === "debug").length).toBe(0); // …not the spine bridge
  });
});

// BUG 4 & 5: the bridge must map severity (not collapse everything to debug) and strip ANSI, and must
// surface ORM errors/warnings even when `debug` is off. Tested on the shipped SpineMikroLogger directly.
describe("SpineMikroLogger severity mapping + ANSI stripping (BUG 4/5)", () => {
  it("routes an ORM error to the spine ERROR path (not debug), even with debug disabled, ANSI stripped", () => {
    const { logger, calls } = makeFakeLogger();
    const bridge = new SpineMikroLogger(
      { writer: () => {}, debugMode: false },
      logger
    );

    bridge.error("query", `${ESC}[31mconnection refused${ESC}[39m`);

    const errors = calls.filter((c) => c.level === "error");
    expect(errors.length).toBe(1);
    expect(errors[0].message).toContain("connection refused");
    expect(errors[0].message).not.toContain(ESC);
    // It surfaced as an error even though debug is off, and was NOT downgraded to debug.
    expect(calls.filter((c) => c.level === "debug").length).toBe(0);
  });

  it("routes an ORM warning to the spine WARN path, even with debug disabled", () => {
    const { logger, calls } = makeFakeLogger();
    const bridge = new SpineMikroLogger(
      { writer: () => {}, debugMode: false },
      logger
    );

    bridge.warn("deprecated", `${ESC}[33muse of a deprecated API${ESC}[39m`);

    const warns = calls.filter((c) => c.level === "warn");
    expect(warns.length).toBe(1);
    expect(warns[0].message).toContain("use of a deprecated API");
    expect(warns[0].message).not.toContain(ESC);
  });

  it("gates general/query output on debug: suppressed when off, routed to debug when on", () => {
    const { logger, calls } = makeFakeLogger();
    const bridge = new SpineMikroLogger(
      { writer: () => {}, debugMode: false },
      logger
    );

    bridge.log("query", "select 1"); // debug off → suppressed
    expect(calls.length).toBe(0);

    bridge.setDebugMode(true);
    bridge.log("query", `${ESC}[36mselect 1${ESC}[39m`); // debug on → routed to debug, ANSI stripped
    const debug = calls.filter((c) => c.level === "debug");
    expect(debug.length).toBe(1);
    expect(debug[0].message).toContain("select 1");
    expect(debug[0].message).not.toContain(ESC);
  });

  // Regression: MikroORM funnels some errors/warnings through log(ns, msg, { level }) — not only via
  // error()/warn(). The debug gate must NOT run before the severity mapping, or these are dropped.
  it("surfaces an error/warning arriving via log() with a level, even when debug is off", () => {
    const { logger, calls } = makeFakeLogger();
    const bridge = new SpineMikroLogger(
      { writer: () => {}, debugMode: false },
      logger
    );

    bridge.log("query", "constraint failed", { level: "error" } as LogContext);
    bridge.log("query", "deprecated option", {
      level: "warning",
    } as LogContext);

    expect(calls.filter((c) => c.level === "error").length).toBe(1);
    expect(calls.filter((c) => c.level === "warn").length).toBe(1);
    expect(calls.filter((c) => c.level === "debug").length).toBe(0);
  });
});
