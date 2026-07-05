import { Injectable } from "@spinejs/core";
import { User, UserRepository } from "./user.entity";

/**
 * A plain singleton service — NO `EntityManager` threaded through its methods, and NO `.save()` /
 * `.flush()`. It mutates domain state; the `MikroOrmInterceptor` commits the request's unit-of-work
 * once, at request end, on a successful dispatch.
 */
@Injectable({ inject: [UserRepository] })
export class UserService {
  constructor(private readonly users: UserRepository) {}

  /**
   * Stages a new user in the request's unit-of-work. `persist()` schedules the insert; the row is
   * written when the request ends — there is no `.save()` / `.flush()` here.
   */
  add(name: string, email: string): void {
    const em = this.users.getEntityManager();
    em.persist(em.create(User, { name, email }));
  }

  /**
   * Loads an entity and mutates a field. MikroORM dirty-tracks the change; it is committed at request
   * end — again, no `.save()`.
   */
  async rename(email: string, name: string): Promise<void> {
    const user = await this.users.findOneOrFail({ email });
    user.name = name;
  }

  findByEmail(email: string): Promise<User | null> {
    return this.users.findByEmail(email);
  }
}
