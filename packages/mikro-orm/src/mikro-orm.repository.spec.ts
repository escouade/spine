import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MikroORM, EntitySchema, EntityRepository } from "@mikro-orm/core";
import { BetterSqliteDriver } from "@mikro-orm/better-sqlite";
import { ClsService, ClsInterceptor } from "@spinejs/cls";
import type {
  DispatchTarget,
  Envelope,
  GatewayContext,
} from "@spinejs/gateway-core";
import { MikroOrmModule, MikroOrmInterceptor, repositoryOf } from "./index";
import { mikroOrmProvider } from "./mikro-orm.module";
import { entityForRepository } from "./mikro-orm.repository";

// --- Entities via EntitySchema; User declares its custom repository (the MikroORM-native link) -----
class User {
  id!: number;
  name!: string;
  email!: string;
}
class UserRepository extends EntityRepository<User> {
  findByEmail(email: string): Promise<User | null> {
    return this.findOne({ email });
  }
}
const UserSchema = new EntitySchema<User>({
  class: User,
  repository: () => UserRepository,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    name: { type: "string" },
    email: { type: "string" },
  },
});

class Product {
  id!: number;
  label!: string;
}
const ProductSchema = new EntitySchema<Product>({
  class: Product,
  properties: {
    id: { type: "number", primary: true, autoincrement: true },
    label: { type: "string" },
  },
});

// A service that injects the custom repository by class token — no manager threaded per call.
class UserService {
  constructor(private readonly users: UserRepository) {}
  add(name: string, email: string): void {
    const em = this.users.getEntityManager();
    em.persist(em.create(User, { name, email } as User));
  }
  findByEmail(email: string): Promise<User | null> {
    return this.users.findByEmail(email);
  }
  async rename(email: string, name: string): Promise<void> {
    const u = await this.users.findOneOrFail({ email });
    u.name = name; // dirty-tracked; committed at request end. No .save().
  }
}

type Factory = (orm: MikroORM) => unknown;

describe("MikroOrmModule.register + repositoryOf (Story 1.4)", () => {
  let orm: MikroORM;
  let cls: ClsService;
  let clsInterceptor: ClsInterceptor<GatewayContext>;
  let mikro: MikroOrmInterceptor;
  let userRepo: UserRepository;
  let productRepo: EntityRepository<Product>;
  let svc: UserService;

  const target: DispatchTarget<GatewayContext> = {
    guards: [],
    invoke: () => undefined,
  };
  const ctx: GatewayContext = {};

  const dispatch = (handler: () => Promise<void>): Promise<Envelope<unknown>> =>
    clsInterceptor.intercept(target, ctx, undefined, () =>
      mikro.intercept(target, ctx, undefined, async () => {
        await handler();
        return { ok: true, data: undefined };
      })
    );

  beforeEach(async () => {
    cls = new ClsService();
    orm = mikroOrmProvider.factory(
      cls,
      {
        driver: BetterSqliteDriver,
        dbName: ":memory:",
        entities: [UserSchema, ProductSchema],
      },
      undefined
    );
    await orm.connect();
    await orm.schema.createSchema();
    clsInterceptor = new ClsInterceptor(cls);
    mikro = new MikroOrmInterceptor(orm, cls);

    // Build the real providers produced by register(), then run their factories to obtain the repos.
    const dyn = MikroOrmModule.register([UserRepository, Product]);
    const factoryFor = (token: unknown): Factory => {
      const p = (dyn.providers ?? []).find(
        (x) => (x as { provide?: unknown }).provide === token
      ) as { factory: Factory };
      return p.factory;
    };
    userRepo = factoryFor(UserRepository)(orm) as UserRepository;
    productRepo = factoryFor(repositoryOf(Product))(
      orm
    ) as EntityRepository<Product>;
    svc = new UserService(userRepo);
  });

  afterEach(async () => {
    await orm.close(true);
  });

  it("provides a custom repository by its class token (bound to the request EM)", () => {
    expect(userRepo).toBeInstanceOf(UserRepository);
    expect(typeof userRepo.findByEmail).toBe("function");
  });

  it("runs a custom repository method against the request fork and persists without .save()", async () => {
    await dispatch(async () => svc.add("alice", "a@x.io"));

    let found: User | null = null;
    await dispatch(async () => {
      found = await svc.findByEmail("a@x.io");
    });
    expect(found).not.toBeNull();
    expect(found!.name).toBe("alice");
  });

  it("commits a mutation loaded via the custom repo with no .save()", async () => {
    await dispatch(async () => svc.add("bob", "b@x.io"));
    await dispatch(async () => svc.rename("b@x.io", "bobby"));

    let name: string | undefined;
    await dispatch(async () => {
      name = (await svc.findByEmail("b@x.io"))?.name;
    });
    expect(name).toBe("bobby");
  });

  it("rolls back a custom-repo write when the request throws", async () => {
    await expect(
      dispatch(async () => {
        svc.add("ghost", "g@x.io");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    let found: User | null = "x" as unknown as User; // sentinel
    await dispatch(async () => {
      found = await svc.findByEmail("g@x.io");
    });
    expect(found).toBeNull();
  });

  it("repositoryOf(Entity) provides a default EntityRepository bound to the request fork", async () => {
    expect(productRepo).toBeInstanceOf(EntityRepository);

    await dispatch(async () => {
      const em = productRepo.getEntityManager();
      em.persist(em.create(Product, { label: "widget" } as Product));
    });

    let count: number | undefined;
    await dispatch(async () => {
      count = await productRepo.count({});
    });
    expect(count).toBe(1);
  });

  it("repositoryOf(Entity) returns a stable token for the same entity", () => {
    expect(repositoryOf(Product)).toBe(repositoryOf(Product));
  });

  it("entityForRepository throws a clear error when no entity declares the repo", () => {
    class OrphanRepository extends EntityRepository<User> {}
    expect(() => entityForRepository(orm, OrphanRepository)).toThrow(
      /no entity declares/
    );
  });
});
