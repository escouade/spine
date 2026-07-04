// Mocks `electron` before anything below imports it transitively, so the real `ElectronIpcGateway`
// binds its routes on a fake `ipcMain` (no Electron process needed).
import { invokeIpc, silentLogger } from "@spinejs/electron-ipc-gateway/testing";

import { App } from "@spinejs/core";
import { createApp } from "./main";
import type { UserView } from "./users.controller";

describe("@spinejs/mikro-orm — request-scoped unit-of-work over the IPC gateway", () => {
  let app: App;

  beforeAll(async () => {
    app = createApp({ logger: silentLogger });
    await app.init(); // builds the graph, registers the routes on the fake ipcMain
    await app.start(); // opens the in-memory sqlite connection + creates the schema
  });

  afterAll(async () => {
    await app.stop();
  });

  it("persists WITHOUT .save() — the write survives into a later request", async () => {
    // The handler only calls `service.add(...)`; the interceptor flushes at request end.
    await invokeIpc("user.add", { name: "alice", email: "alice@example.io" });

    const found = await invokeIpc<UserView | null>("user.byEmail", {
      email: "alice@example.io",
    });
    expect(found).toMatchObject({ name: "alice", email: "alice@example.io" });
    // The id was assigned by the request-end flush — proof the insert really was committed.
    expect(found?.id).toBeGreaterThan(0);
  });

  it("commits a mutation with no .save() (dirty-tracking)", async () => {
    await invokeIpc("user.add", { name: "bob", email: "bob@example.io" });
    // `rename` just loads the entity and assigns a field — no .save(); committed at request end.
    await invokeIpc("user.rename", { email: "bob@example.io", name: "bobby" });

    const found = await invokeIpc<UserView | null>("user.byEmail", {
      email: "bob@example.io",
    });
    expect(found?.name).toBe("bobby");
  });

  it("an error dispatch persists NOTHING — the unit-of-work is dropped", async () => {
    // The handler stages an insert, then throws: the envelope is { ok: false }, so no flush happens.
    await expect(
      invokeIpc("user.addThenFail", {
        name: "ghost",
        email: "ghost@example.io",
      })
    ).rejects.toThrow();

    const found = await invokeIpc<UserView | null>("user.byEmail", {
      email: "ghost@example.io",
    });
    expect(found).toBeNull();
  });

  it("isolates CONCURRENT requests — one commits while the other rolls back", async () => {
    const [committed, rolledBack] = await Promise.allSettled([
      invokeIpc("user.add", { name: "carol", email: "carol@example.io" }),
      invokeIpc("user.addThenFail", { name: "dave", email: "dave@example.io" }),
    ]);
    expect(committed.status).toBe("fulfilled");
    expect(rolledBack.status).toBe("rejected");

    // The committing request's write survived; the failing request's write never landed. Each dispatch
    // had its OWN forked EntityManager / unit-of-work, isolated by async context (CLS) — neither the
    // rollback discarded the other's insert, nor did the flush accidentally commit the other's.
    const carol = await invokeIpc<UserView | null>("user.byEmail", {
      email: "carol@example.io",
    });
    const dave = await invokeIpc<UserView | null>("user.byEmail", {
      email: "dave@example.io",
    });
    expect(carol).toMatchObject({ name: "carol" });
    expect(dave).toBeNull();
  });
});
