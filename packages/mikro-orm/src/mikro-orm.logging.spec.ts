import { describe, it, expect } from "vitest";
import { EntitySchema } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { ClsService } from "@spinejs/cls";
import type { Logger } from "@spinejs/core";
import { mikroOrmProvider } from "./mikro-orm.module";

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
  it("routes MikroORM log output through the injected spine logger (one sink)", async () => {
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
  });

  it("does not crash when no logger is available (graceful degradation)", async () => {
    const orm = mikroOrmProvider.factory(
      new ClsService(),
      baseOptions(),
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
