import type { Logger } from "../logger";
import { Container, Injectable, InjectionToken } from ".";
import { stringifyToken } from "./container";

const silentLogger = {
  info() {},
  error() {},
  warn() {},
  debug() {},
  verbose() {},
  fatal() {},
  exit: async () => {},
} as unknown as Logger;

const makeContainer = (parent?: Container) =>
  new Container(silentLogger, "test", parent);

describe("Container", () => {
  describe("value providers", () => {
    it("returns the registered value", () => {
      const token = new InjectionToken<string>("greeting");
      const container = makeContainer();
      container.add({ provide: token, value: "hello" });
      expect(container.get(token)).toBe("hello");
    });

    it('supports falsy values without treating them as "invalid provider"', () => {
      const container = makeContainer();
      const cases: [InjectionToken<unknown>, unknown][] = [
        [new InjectionToken("zero"), 0],
        [new InjectionToken("empty"), ""],
        [new InjectionToken("false"), false],
        [new InjectionToken("null"), null],
      ];
      for (const [token, value] of cases) {
        container.add({ provide: token, value });
        expect(container.get(token)).toBe(value);
      }
    });
  });

  describe("factory providers", () => {
    it("calls the factory with injected dependencies in order", () => {
      const a = new InjectionToken<string>("a");
      const b = new InjectionToken<string>("b");
      const c = new InjectionToken<string>("c");
      const container = makeContainer();
      container.add({ provide: a, value: "A" });
      container.add({ provide: b, value: "B" });
      container.add({
        provide: c,
        factory: (x: string, y: string) => `${x}+${y}`,
        inject: [a, b],
      });
      expect(container.get(c)).toBe("A+B");
    });

    it("memoizes the result (singleton): the factory runs once", () => {
      const token = new InjectionToken<object>("obj");
      let calls = 0;
      const container = makeContainer();
      container.add({
        provide: token,
        factory: () => {
          calls++;
          return {};
        },
      });
      const first = container.get(token);
      const second = container.get(token);
      expect(first).toBe(second);
      expect(calls).toBe(1);
    });

    it("caches a falsy factory result (regression: must use `has`, not truthiness)", () => {
      const token = new InjectionToken<number>("zero");
      let calls = 0;
      const container = makeContainer();
      container.add({
        provide: token,
        factory: () => {
          calls++;
          return 0;
        },
      });
      expect(container.get(token)).toBe(0);
      expect(container.get(token)).toBe(0);
      expect(calls).toBe(1);
    });
  });

  describe("class providers", () => {
    it("instantiates a class with no dependencies", () => {
      class Service {}
      const container = makeContainer();
      container.add({ provide: Service });
      expect(container.get(Service)).toBeInstanceOf(Service);
    });

    it("injects constructor dependencies", () => {
      class Dep {}
      class Service {
        constructor(public dep: Dep) {}
      }
      const container = makeContainer();
      container.add({ provide: Dep });
      container.add({ provide: Service, inject: [Dep] });
      const service = container.get<Service>(Service);
      expect(service).toBeInstanceOf(Service);
      expect(service.dep).toBeInstanceOf(Dep);
    });

    it("returns a singleton instance", () => {
      class Service {}
      const container = makeContainer();
      container.add({ provide: Service });
      expect(container.get(Service)).toBe(container.get(Service));
    });
  });

  describe("delegate providers", () => {
    it("delegates resolution to the provided function", () => {
      const token = new InjectionToken<number>("delegated");
      const container = makeContainer();
      container.add({ provide: token, delegate: () => 42 });
      expect(container.get(token)).toBe(42);
    });
  });

  describe("existing providers", () => {
    it("aliases to the same instance as the target token", () => {
      class Service {}
      const alias = new InjectionToken<Service>("alias");
      const container = makeContainer();
      container.add({ provide: Service });
      container.add({ provide: alias, existing: Service });
      expect(container.get(alias)).toBe(container.get(Service));
    });

    it("resolves the target only once (shared singleton)", () => {
      const token = new InjectionToken<object>("obj");
      const alias = new InjectionToken<object>("alias");
      let calls = 0;
      const container = makeContainer();
      container.add({
        provide: token,
        factory: () => {
          calls++;
          return {};
        },
      });
      container.add({ provide: alias, existing: token });
      container.get(alias);
      container.get(token);
      expect(calls).toBe(1);
    });

    it("rejects a provider that aliases itself", () => {
      const token = new InjectionToken<unknown>("self");
      const container = makeContainer();
      container.add({ provide: token, existing: token });
      expect(() => container.get(token)).toThrow(/Circular dependency/);
    });
  });

  describe("provider scope", () => {
    it("transient factory: a fresh result on every resolution", () => {
      const token = new InjectionToken<object>("obj");
      let calls = 0;
      const container = makeContainer();
      container.add({
        provide: token,
        scope: "transient",
        factory: () => {
          calls++;
          return {};
        },
      });
      const first = container.get(token);
      const second = container.get(token);
      expect(first).not.toBe(second);
      expect(calls).toBe(2);
    });

    it("transient class (via provider scope): a new instance each time", () => {
      class Service {}
      const container = makeContainer();
      container.add({ provide: Service, scope: "transient" });
      expect(container.get(Service)).not.toBe(container.get(Service));
    });

    it("transient class (via @Injectable scope): a new instance each time", () => {
      @Injectable({ scope: "transient" })
      class Service {}
      const container = makeContainer();
      container.add({ provide: Service });
      expect(container.get(Service)).not.toBe(container.get(Service));
    });

    it("provider scope wins over the @Injectable scope", () => {
      @Injectable({ scope: "transient" })
      class Service {}
      const container = makeContainer();
      container.add({ provide: Service, scope: "singleton" });
      expect(container.get(Service)).toBe(container.get(Service));
    });

    it("a transient injected into a singleton is resolved once (captured)", () => {
      class Dep {}
      class Service {
        constructor(public dep: Dep) {}
      }
      const container = makeContainer();
      container.add({ provide: Dep, scope: "transient" });
      container.add({ provide: Service, inject: [Dep] });
      const a = container.get<Service>(Service);
      const b = container.get<Service>(Service);
      expect(a).toBe(b); // Service is a singleton
      expect(a.dep).toBe(b.dep); // its transient dep captured once
    });

    it("defaults to singleton when no scope is set", () => {
      class Service {}
      const container = makeContainer();
      container.add({ provide: Service });
      expect(container.get(Service)).toBe(container.get(Service));
    });
  });

  describe("parent resolution", () => {
    it("falls back to the parent container", () => {
      const token = new InjectionToken<string>("shared");
      const parent = makeContainer();
      parent.add({ provide: token, value: "from-parent" });
      const child = makeContainer(parent);
      expect(child.get(token)).toBe("from-parent");
    });

    it("prefers its own registration over the parent", () => {
      const token = new InjectionToken<string>("shared");
      const parent = makeContainer();
      parent.add({ provide: token, value: "from-parent" });
      const child = makeContainer(parent);
      child.add({ provide: token, value: "from-child" });
      expect(child.get(token)).toBe("from-child");
    });
  });

  describe("has", () => {
    it("reflects registration state", () => {
      const token = new InjectionToken("x");
      const container = makeContainer();
      expect(container.has(token)).toBe(false);
      container.add({ provide: token, value: 1 });
      expect(container.has(token)).toBe(true);
    });

    it("ignores a second registration of the same token (idempotent)", () => {
      const token = new InjectionToken<string>("x");
      const container = makeContainer();
      container.add({ provide: token, value: "first" });
      container.add({ provide: token, value: "second" });
      expect(container.get(token)).toBe("first");
    });
  });

  describe("unknown provider errors", () => {
    it("hints that a class token is likely a misused Module/service", () => {
      class NotRegistered {}
      const container = makeContainer();
      expect(() => container.get(NotRegistered)).toThrow(
        /Unknown provider NotRegistered/
      );
      expect(() => container.get(NotRegistered)).toThrow(/is a class/);
    });

    it("describes an unregistered InjectionToken", () => {
      const token = new InjectionToken("config");
      const container = makeContainer();
      expect(() => container.get(token)).toThrow(/InjectionToken\(config\)/);
      expect(() => container.get(token)).toThrow(
        /not registered as a provider/
      );
    });

    it("includes the resolution chain for nested failures", () => {
      class Missing {}
      class Service {
        constructor(public missing: Missing) {}
      }
      const container = makeContainer();
      container.add({ provide: Service, inject: [Missing] });
      expect(() => container.get(Service)).toThrow(
        /Resolution chain: Service -> Missing/
      );
    });
  });

  describe("circular dependency detection", () => {
    it("rejects a provider that injects itself (at registration)", () => {
      class SelfRef {}
      const container = makeContainer();
      expect(() =>
        container.add({ provide: SelfRef, inject: [SelfRef] })
      ).toThrow(/injects itself/);
    });

    it("detects a direct cycle (A <-> B) at resolution", () => {
      class A {}
      class B {}
      const container = makeContainer();
      container.add({ provide: A, inject: [B] });
      container.add({ provide: B, inject: [A] });
      expect(() => container.get(A)).toThrow(/Circular dependency/);
    });

    it("detects a transitive cycle (A -> B -> C -> A)", () => {
      class A {}
      class B {}
      class C {}
      const container = makeContainer();
      container.add({ provide: A, inject: [B] });
      container.add({ provide: B, inject: [C] });
      container.add({ provide: C, inject: [A] });
      expect(() => container.get(A)).toThrow(/Circular dependency/);
    });

    it("does not flag a diamond (shared dependency) as a cycle", () => {
      class D {}
      class B {
        constructor(public d: D) {}
      }
      class C {
        constructor(public d: D) {}
      }
      class A {
        constructor(public b: B, public c: C) {}
      }
      const container = makeContainer();
      container.add({ provide: D });
      container.add({ provide: B, inject: [D] });
      container.add({ provide: C, inject: [D] });
      container.add({ provide: A, inject: [B, C] });
      const a = container.get<A>(A);
      expect(a).toBeInstanceOf(A);
      // D resolved once and shared across both branches.
      expect(a.b.d).toBe(a.c.d);
    });
  });
});

describe("stringifyToken", () => {
  it("uses the class name for constructor tokens", () => {
    class MyService {}
    expect(stringifyToken(MyService)).toBe("MyService");
  });

  it("uses the description for InjectionToken instances", () => {
    expect(stringifyToken(new InjectionToken("my-token"))).toBe(
      "InjectionToken(my-token)"
    );
  });
});
