import { describe, expect, it, vi } from "vitest";
import { ClsModule, ClsService } from "@spinejs/cls";
import type { FactoryProvider, Logger } from "@spinejs/core";
import { SchedulerModule } from "./scheduler.module";
import { SchedulerRegistry } from "./scheduler.registry";

const silentLog = (): Logger => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
});

const registryProviderOf = (dm: {
  providers?: unknown[];
}): FactoryProvider<SchedulerRegistry> => {
  const provider = dm.providers?.find(
    (p): p is FactoryProvider<SchedulerRegistry> =>
      typeof p === "object" &&
      p !== null &&
      "provide" in p &&
      (p as { provide: unknown }).provide === SchedulerRegistry
  );
  if (!provider) throw new Error("SchedulerRegistry provider not found");
  return provider;
};

describe("SchedulerModule.configure", () => {
  it("returns a DynamicModule importing ClsModule (+ user imports) with a SchedulerRegistry factory", () => {
    class DepA {}
    const dm = SchedulerModule.configure({
      tasks: [{ name: "t", everyMs: 1000, inject: [DepA], run: () => {} }],
    });

    expect(dm.module).toBe(SchedulerModule);
    expect(dm.imports).toContain(ClsModule);
    // inject = [ClsService, loggerToken, ...flattened task tokens]
    expect(registryProviderOf(dm).inject).toEqual([
      ClsService,
      expect.anything(), // loggerToken
      DepA,
    ]);
  });

  it("factory slices resolved deps back to each task by inject arity", async () => {
    class A {}
    class B {}
    const a = new A();
    const b = new B();
    const received: Record<string, unknown[]> = {};

    const dm = SchedulerModule.configure({
      tasks: [
        {
          name: "t1",
          everyMs: 1000,
          inject: [A],
          run: (x: A) => {
            received.t1 = [x];
          },
        },
        {
          name: "t2",
          everyMs: 1000,
          inject: [A, B],
          run: (x: A, y: B) => {
            received.t2 = [x, y];
          },
        },
      ],
    });

    // inject = [ClsService, loggerToken, A, A, B] → args (cls, log, aFor_t1, aFor_t2, bFor_t2)
    const registry = registryProviderOf(dm).factory(
      new ClsService(),
      silentLog(),
      a,
      a,
      b
    );

    expect(registry.taskNames).toEqual(["t1", "t2"]);
    await registry.runNow("t1");
    await registry.runNow("t2");
    expect(received.t1).toEqual([a]);
    expect(received.t2).toEqual([a, b]);
  });

  it("onStart arms the registry; onStop drains it", async () => {
    const registry = new SchedulerRegistry(new ClsService(), silentLog());
    const start = vi.spyOn(registry, "start");
    const stop = vi.spyOn(registry, "stop").mockResolvedValue(undefined);

    const mod = new SchedulerModule(registry);
    mod.onStart();
    expect(start).toHaveBeenCalledOnce();
    await mod.onStop();
    expect(stop).toHaveBeenCalledOnce();
  });
});
