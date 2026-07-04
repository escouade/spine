import {
  MikroORM,
  EntitySchema,
  type EntityManager,
} from "@mikro-orm/better-sqlite";
import { ClsService } from "@spinejs/cls";

// --- Entity WITHOUT decorators (EntitySchema) --------------------------------------------
// Deliberate: isolates the fact under test (a CLS-backed request context) from the separate
// question of decorator entities under spine's no-reflect-metadata tsconfig (ADR 0008).
class User {
  id!: number;
  name!: string;
}

const UserSchema = new EntitySchema<User>({
  class: User,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    name: { type: "string" },
  },
});

// The CLS store: one key holding this request's forked EntityManager.
interface OrmStore {
  em: EntityManager;
}

// A "service" holding ONLY the orm handle — no manager threaded in, no ctx argument.
// The differentiator: it reads orm.em and must transparently get THIS request's fork.
class UserService {
  constructor(private readonly orm: MikroORM) {}
  async rename(id: number, name: string): Promise<void> {
    const user = await this.orm.em.findOneOrFail(User, { id });
    user.name = name; // dirty-tracked; committed at request end. No .save().
  }
  async find(id: number): Promise<User | null> {
    return this.orm.em.findOne(User, { id });
  }
}

describe("spike: request-scoped EntityManager via spine CLS", () => {
  let orm: MikroORM;
  let cls: ClsService<OrmStore>;

  // Simulate a request: open a CLS scope, fork a fresh EM into it, transaction around the work.
  async function handleRequest<R>(fn: () => Promise<R>): Promise<R> {
    return cls.run({} as OrmStore, async () => {
      const em = orm.em.fork();
      cls.set("em", em);
      await em.begin();
      try {
        const r = await fn();
        await em.commit(); // flush the UnitOfWork, then COMMIT
        return r;
      } catch (e) {
        await em.rollback();
        throw e;
      }
    });
  }

  beforeAll(async () => {
    cls = new ClsService<OrmStore>();
    orm = await MikroORM.init({
      dbName: ":memory:",
      entities: [UserSchema],
      // THE LOAD-BEARING FACT: spine's CLS is MikroORM's context store. One ALS, spine's.
      context: () => cls.get("em"),
      allowGlobalContext: true, // fork() reads the global em before a context exists
    });
    await orm.schema.createSchema();
    await handleRequest(async () => {
      const em = cls.get("em")!;
      em.persist(em.create(User, { name: "before" }));
    });
  });

  afterAll(async () => {
    await orm.close(true);
  });

  it("orm.em delegates to that request's fork via getContext (context hook works)", async () => {
    await handleRequest(async () => {
      // orm.em (getter) is ALWAYS the root manager; it delegates each operation to the
      // contextual fork through getContext(), which reads our `context` callback → the CLS
      // fork. So the identity lives on getContext(), not on the getter itself.
      expect(orm.em.getContext()).toBe(cls.get("em"));
      expect(orm.em.getContext()).not.toBe(orm.em); // proof: root ≠ request fork
    });
  });

  it("a service with no threaded manager persists via the request UnitOfWork (no .save())", async () => {
    const svc = new UserService(orm);
    expect((await handleRequest(() => svc.find(1)))?.name).toBe("before");

    await handleRequest(() => svc.rename(1, "after")); // mutate; commit at request end

    expect((await handleRequest(() => svc.find(1)))?.name).toBe("after");
  });

  it("rolls back on error — nothing commits", async () => {
    const svc = new UserService(orm);
    await expect(
      handleRequest(async () => {
        await svc.rename(1, "doomed");
        throw new Error("boom"); // triggers rollback
      })
    ).rejects.toThrow("boom");

    expect((await handleRequest(() => svc.find(1)))?.name).toBe("after"); // unchanged
  });

  it("concurrent requests are isolated (each gets its own fork)", async () => {
    // No transaction here (single in-memory connection can't hold two) — this proves the
    // CLS + fork isolation, which is the mechanism under test.
    const isolate = () =>
      cls.run({} as OrmStore, async () => {
        const mine = orm.em.fork();
        cls.set("em", mine);
        await new Promise((r) => setTimeout(r, 5));
        expect(cls.get("em")).toBe(mine); // still mine after an await
        return mine;
      });

    const [a, b] = await Promise.all([isolate(), isolate()]);
    expect(a).not.toBe(b); // two requests, two forks
  });
});
