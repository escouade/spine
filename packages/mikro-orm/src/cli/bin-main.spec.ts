import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModuleEntry } from "@spinejs/core";
import { runCli, loadAppModule, type CliDeps } from "./bin-main";

// Story 2.6 — the thin bin's exit-code mapping. Unit-tested with fake collaborators (no boot, no
// spawn); `bin.ts` itself is a two-line wrapper that maps the returned code to `process.exit`.

class DummyAppModule {}

const makeDeps = (over: Partial<CliDeps> = {}): CliDeps => ({
  runMigrations: vi.fn(async () => {}),
  loadAppModule: vi.fn(async () => DummyAppModule as unknown as ModuleEntry),
  logError: vi.fn(),
  ...over,
});

describe("runCli", () => {
  it("loads the AppModule, runs the verb, and returns exit code 0 on success", async () => {
    const deps = makeDeps();

    const code = await runCli(
      [
        "migration:up",
        "--module",
        "./app.js#AppModule",
        "--connection",
        "analytics",
      ],
      deps
    );

    expect(code).toBe(0);
    expect(deps.loadAppModule).toHaveBeenCalledWith("./app.js#AppModule");
    // The --module flag is stripped; runMigrations sees only the verb + its own flags.
    expect(deps.runMigrations).toHaveBeenCalledWith(DummyAppModule, [
      "migration:up",
      "--connection",
      "analytics",
    ]);
  });

  it("accepts the inline --module=<spec> form", async () => {
    const deps = makeDeps();

    await runCli(["migration:list", "--module=./app.js#AppModule"], deps);

    expect(deps.loadAppModule).toHaveBeenCalledWith("./app.js#AppModule");
    expect(deps.runMigrations).toHaveBeenCalledWith(DummyAppModule, [
      "migration:list",
    ]);
  });

  it("returns 1 and logs an actionable message when --module is missing", async () => {
    const deps = makeDeps();

    const code = await runCli(["migration:up"], deps);

    expect(code).toBe(1);
    expect(deps.runMigrations).not.toHaveBeenCalled();
    expect(deps.logError).toHaveBeenCalledWith(
      expect.stringMatching(/--module <path>#<Export>/)
    );
  });

  it("returns non-zero and logs when the migration fails (SM-3)", async () => {
    const deps = makeDeps({
      runMigrations: vi.fn(async () => {
        throw new Error("migration 2 failed; batch rolled back");
      }),
    });

    const code = await runCli(
      ["migration:up", "--module", "./app.js#AppModule"],
      deps
    );

    expect(code).toBe(1);
    expect(deps.logError).toHaveBeenCalledWith(
      "migration 2 failed; batch rolled back"
    );
  });

  it("returns 1 when the AppModule cannot be loaded", async () => {
    const deps = makeDeps({
      loadAppModule: vi.fn(async () => {
        throw new Error('module "./nope.js" has no export "AppModule".');
      }),
    });

    const code = await runCli(
      ["migration:up", "--module", "./nope.js#AppModule"],
      deps
    );

    expect(code).toBe(1);
    expect(deps.runMigrations).not.toHaveBeenCalled();
    expect(deps.logError).toHaveBeenCalledWith(
      expect.stringMatching(/no export "AppModule"/)
    );
  });
});

describe("loadAppModule", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "spine-bin-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves a named export via <path>#<Export>", async () => {
    const file = join(dir, "app.mjs");
    writeFileSync(file, "export class AppModule {}\nexport const other = 1;\n");

    const mod = await loadAppModule(`${file}#AppModule`);

    expect((mod as { name: string }).name).toBe("AppModule");
  });

  it("falls back to the default export when no #Export and no AppModule name", async () => {
    const file = join(dir, "app-default.mjs");
    writeFileSync(file, "export default class Root {}\n");

    const mod = await loadAppModule(file);

    expect((mod as { name: string }).name).toBe("Root");
  });

  it("prefers a AppModule named export over default (CJS-interop safety)", async () => {
    // A CJS-compiled app exposes `default` as the module.exports wrapper (always defined); the named
    // export is the class in both ESM and CJS, so it must win over `default`.
    const file = join(dir, "app-both.mjs");
    writeFileSync(
      file,
      "export default class Wrapper {}\nexport class AppModule {}\n"
    );

    const mod = await loadAppModule(file);

    expect((mod as { name: string }).name).toBe("AppModule");
  });

  it("throws an actionable error when the named export is absent", async () => {
    const file = join(dir, "empty.mjs");
    writeFileSync(file, "export const x = 1;\n");

    await expect(loadAppModule(`${file}#AppModule`)).rejects.toThrow(
      /has no export "AppModule"/
    );
  });
});
