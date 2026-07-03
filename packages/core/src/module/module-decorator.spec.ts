import type { Logger } from "../logger";
import { App } from "../app";
import { Injectable, InjectionToken } from "../container";
import { Module, DynamicModule } from "./index";

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;

const makeApp = (modules: ConstructorParameters<typeof App>[0]) =>
  new App(modules, { logger: silentLogger, handleProcessExit: false });

const SIGNALS = [
  "uncaughtException",
  "unhandledRejection",
  "exit",
  "SIGINT",
  "SIGUSR1",
  "SIGUSR2",
] as const;
let snapshot: Record<string, unknown[]>;
beforeEach(() => {
  snapshot = {};
  for (const s of SIGNALS)
    snapshot[s] = process.listeners(s as NodeJS.Signals).slice();
});
afterEach(() => {
  for (const s of SIGNALS)
    for (const l of process.listeners(s as NodeJS.Signals))
      if (!snapshot[s].includes(l))
        process.removeListener(s as NodeJS.Signals, l as never);
});

describe("@Module / @Injectable / configure", () => {
  it("wires the full decorator path end-to-end", async () => {
    const optToken = new InjectionToken<{ name: string }>("deco:opt");

    @Injectable({ inject: [optToken] })
    class Greeter {
      constructor(private readonly opt: { name: string }) {}
      hello() {
        return `hi ${this.opt.name}`;
      }
    }

    @Module({
      providers: [{ provide: optToken, value: { name: "default" } }, Greeter],
      exports: [Greeter],
    })
    class GreeterModule {
      static configure(name: string): DynamicModule {
        return {
          module: GreeterModule,
          providers: [{ provide: optToken, value: { name } }],
        };
      }
    }

    let captured: string | undefined;
    let inited = false;

    // Module constructor deps declared via `inject`.
    @Module({ inject: [Greeter], imports: [GreeterModule.configure("world")] })
    class RootModule {
      constructor(private readonly greeter: Greeter) {}
      onInit() {
        inited = true;
        captured = this.greeter.hello();
      }
    }

    await makeApp([RootModule]).init();

    expect(inited).toBe(true);
    // configure('world') did override the default provider { name: 'default' }.
    expect(captured).toBe("hi world");
  });

  it("applies configure() even when a bare import sits in another branch (no resolution-order race)", async () => {
    const tagToken = new InjectionToken<string>("deco:tag");

    @Module({
      providers: [{ provide: tagToken, value: "base" }],
      exports: [tagToken],
    })
    class SharedModule {
      static configure(tag: string): DynamicModule {
        return {
          module: SharedModule,
          providers: [{ provide: tagToken, value: tag }],
        };
      }
    }

    let seenByBare: string | undefined;

    // Branch that imports SharedModule **bare** and consumes its exported token.
    @Module({ inject: [tagToken], imports: [SharedModule] })
    class BranchBare {
      constructor(tag: string) {
        seenByBare = tag;
      }
    }

    // **Separate** branch that configures the same SharedModule.
    @Module({ imports: [SharedModule.configure("configured")] })
    class BranchConfigured {}

    // BranchBare first: without the expansion pre-pass, it would resolve SharedModule
    // (and freeze `base` in the container) before BranchConfigured had merged.
    @Module({ imports: [BranchBare, BranchConfigured] })
    class Root {}

    await makeApp([Root]).init();

    expect(seenByBare).toBe("configured");
  });
});
