import { ModuleNode } from "./module-node";
import { InjectionToken, Provider } from "../container";

// A module is now a plain class (no more base class).
class Root {}

describe("ModuleNode", () => {
  describe("getters", () => {
    it("exposes def fields read-only via getters", () => {
      const tok = new InjectionToken<string>("mp:greeting");
      const p = new ModuleNode({
        module: Root,
        inject: [tok],
        exports: [tok],
        providers: [{ provide: tok, value: "hi" }],
      });

      expect(p.module).toBe(Root);
      expect(p.inject).toEqual([tok]);
      expect(p.exports).toEqual([tok]);
      expect(p.providers).toEqual([{ provide: tok, value: "hi" }]);
    });

    it("clones the def at construction (mutating the source array does not leak in)", () => {
      const providers: Provider[] = [
        { provide: new InjectionToken("mp:a"), value: 1 },
      ];
      const p = new ModuleNode({ module: Root, providers });

      providers.push({ provide: new InjectionToken("mp:b"), value: 2 });

      expect(p.providers).toHaveLength(1);
    });
  });

  describe("addProviders()", () => {
    it("appends a provider for an unseen token", () => {
      const a = new InjectionToken<number>("mp:a");
      const b = new InjectionToken<number>("mp:b");
      const p = new ModuleNode({
        module: Root,
        providers: [{ provide: a, value: 1 }],
      });

      p.addProviders([{ provide: b, value: 2 }]);

      expect(p.providers).toEqual([
        { provide: a, value: 1 },
        { provide: b, value: 2 },
      ]);
    });

    it("upserts (replaces in place) a provider for an existing token", () => {
      const a = new InjectionToken<number>("mp:a");
      const p = new ModuleNode({
        module: Root,
        providers: [{ provide: a, value: 1 }],
      });

      p.addProviders([{ provide: a, value: 99 }]);

      // replaced, not duplicated — otherwise the Container's "first wins" would keep the old one.
      expect(p.providers).toEqual([{ provide: a, value: 99 }]);
    });

    it("matches tokens by identity, not by description", () => {
      const shared = new InjectionToken("mp:same");
      const p = new ModuleNode({
        module: Root,
        providers: [{ provide: shared, value: 1 }],
      });

      // Same token instance → replaced.
      p.addProviders([{ provide: shared, value: 2 }]);
      expect(p.providers).toHaveLength(1);
      expect(p.providers?.[0]).toMatchObject({ value: 2 });

      // Distinct token but same description → NOT the same key (identity, not value).
      p.addProviders([{ provide: new InjectionToken("mp:same"), value: 3 }]);
      expect(p.providers).toHaveLength(2);
    });

    it("starts from an empty list when no providers were defined", () => {
      const a = new InjectionToken<number>("mp:a");
      const p = new ModuleNode({ module: Root });

      p.addProviders([{ provide: a, value: 1 }]);

      expect(p.providers).toEqual([{ provide: a, value: 1 }]);
    });

    it("mutates the shared instance and returns this (chainable)", () => {
      const a = new InjectionToken<number>("mp:a");
      const p = new ModuleNode({ module: Root });

      const ret = p.addProviders([{ provide: a, value: 1 }]);

      // Shared pointer: an importer holding `p` sees the config.
      expect(ret).toBe(p);
    });
  });
});
