// Mocks `electron` before anything below imports it transitively, so the real
// `ElectronIpcGateway` binds its routes on a fake `ipcMain` (no Electron process needed).
import { invokeIpc, silentLogger } from "@spinejs/electron-ipc-gateway/testing";

import { App } from "@spinejs/core";
import { createApp } from "./main";
import type { WhoAmIResult } from "./whoami.controller";

describe("CLS request context over the electron IPC gateway", () => {
  let app: App;

  beforeAll(async () => {
    app = createApp({ logger: silentLogger });
    await app.init(); // registers the "whoami" route on the fake ipcMain
  });

  afterAll(async () => {
    await app.stop();
  });

  it("gives each concurrent dispatch the right user via a shared singleton", async () => {
    const [alice, bob] = await Promise.all([
      invokeIpc<WhoAmIResult>("whoami", { user: "alice" }),
      invokeIpc<WhoAmIResult>("whoami", { user: "bob" }),
    ]);

    // The singleton AuditService saw the correct per-request user in each concurrent scope.
    expect(alice.user).toBe("alice");
    expect(bob.user).toBe("bob");

    // Each dispatch got its own reqId.
    expect(alice.reqId).not.toBe(bob.reqId);
  });

  it("defaults to anonymous when no user is supplied", async () => {
    const result = await invokeIpc<WhoAmIResult>("whoami", {});
    expect(result.user).toBe("anonymous");
  });
});
