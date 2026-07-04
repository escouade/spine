/**
 * Compile-time safety net for repository injection (ADR 0016 §3, NFR6). This file is **type-checked**
 * (`tsc -p tsconfig.json`) but never imported — so it ships nowhere and runs nowhere; its only job is
 * to make `yarn nx typecheck mikro-orm` fail if the class-token / `repositoryOf` typing ever regresses.
 *
 * The `@ts-expect-error` lines assert that a wrong token type in an `inject:` array does NOT compile:
 * if the mismatch ever became assignable, the directive would report "unused" and typecheck would fail.
 */
import { Injectable } from "@spinejs/core";
import { EntityRepository } from "@mikro-orm/core";
import { repositoryOf } from "./mikro-orm.repository";

class User {
  id!: number;
  name!: string;
  email!: string;
}
class Product {
  id!: number;
  name!: string;
  sku!: string;
}

class UserRepository extends EntityRepository<User> {
  findByEmail(email: string): Promise<User | null> {
    return this.findOne({ email });
  }
}
class ProductRepository extends EntityRepository<Product> {
  findBySku(sku: string): Promise<Product | null> {
    return this.findOne({ sku });
  }
}

// --- Custom repository class token ---------------------------------------------------------------
class GoodRepoConsumer {
  constructor(readonly users: UserRepository) {}
}
class WrongRepoConsumer {
  constructor(readonly products: ProductRepository) {}
}

// OK: the constructor param matches the injected class token.
Injectable({ inject: [UserRepository] })(GoodRepoConsumer);
// @ts-expect-error ProductRepository is not the injected UserRepository — must not compile.
Injectable({ inject: [UserRepository] })(WrongRepoConsumer);

// --- repositoryOf(Entity) token -----------------------------------------------------------------
class GoodRepoOfConsumer {
  constructor(readonly products: EntityRepository<Product>) {}
}
class WrongRepoOfConsumer {
  constructor(readonly users: EntityRepository<User>) {}
}

// OK: repositoryOf(Product) resolves to EntityRepository<Product>.
Injectable({ inject: [repositoryOf(Product)] })(GoodRepoOfConsumer);
// @ts-expect-error repositoryOf(Product) is EntityRepository<Product>, not <User> — must not compile.
Injectable({ inject: [repositoryOf(Product)] })(WrongRepoOfConsumer);
