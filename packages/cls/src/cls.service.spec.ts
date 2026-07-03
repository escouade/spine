import { ClsService } from "./cls.service";

interface UserStore {
  user: string;
  reqId: string;
}

describe("ClsService", () => {
  it("reads and writes within an active scope", () => {
    const cls = new ClsService();
    cls.run({ user: "alice" }, () => {
      expect(cls.get("user")).toBe("alice");
      cls.set("reqId", "r-1");
      expect(cls.get("reqId")).toBe("r-1");
      expect(cls.has("user")).toBe(true);
      expect(cls.has("missing")).toBe(false);
    });
  });

  it("key-checks get/set when narrowed via a subclass", () => {
    class UserContext extends ClsService<UserStore> {}
    const ctx = new UserContext();
    ctx.run({ user: "alice", reqId: "r-1" }, () => {
      const user: string | undefined = ctx.get("user"); // compiles: T["user"] is string
      expect(user).toBe("alice");
      ctx.set("reqId", "r-2");
      expect(ctx.get("reqId")).toBe("r-2");
    });
  });

  it("reports whether a scope is active", () => {
    const cls = new ClsService();
    expect(cls.active).toBe(false);
    cls.run({}, () => expect(cls.active).toBe(true));
    expect(cls.active).toBe(false);
  });

  it("returns undefined and throws outside a scope", () => {
    const cls = new ClsService();
    expect(cls.get("user")).toBeUndefined();
    expect(() => cls.set("user", "x")).toThrow(/outside an active scope/);
  });

  it("does not leak writes back into the seed object", () => {
    const cls = new ClsService();
    const seed = { user: "alice" };
    cls.run(seed, () => cls.set("reqId", "r-1"));
    expect(seed).toEqual({ user: "alice" }); // seed was cloned
  });

  it("isolates concurrent scopes (the core guarantee)", async () => {
    const cls = new ClsService();
    const readBack = (user: string) =>
      cls.run({ user }, async () => {
        await new Promise((r) => setTimeout(r, 5)); // force interleaving
        return cls.get("user");
      });
    const [a, b] = await Promise.all([readBack("alice"), readBack("bob")]);
    expect(a).toBe("alice");
    expect(b).toBe("bob");
  });
});
