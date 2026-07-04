import { z } from "zod";
import { Controller } from "@spinejs/gateway-core";
import { handle } from "@spinejs/electron-ipc-gateway";
import { UserService } from "./user.service";

/** The plain shape a handler returns for a user (never the live ORM entity). */
export interface UserView {
  id: number;
  name: string;
  email: string;
}

const addSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
});
const byEmailSchema = z.object({ email: z.string().email() });
const renameSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
});

/** Small delay so the concurrency test can interleave two in-flight dispatches. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/**
 * A singleton controller. Each handler is a unit-of-work: it mutates through the service and returns;
 * the `MikroOrmInterceptor` flushes on success and drops everything on failure. Handlers never call
 * `.save()` / `.flush()` and never touch a transaction.
 */
@Controller({ inject: [UserService] })
export class UsersController {
  constructor(private readonly users: UserService) {}

  // Persist a new user. Committed by the interceptor when this dispatch succeeds.
  add = handle(
    "user.add",
    { input: addSchema },
    async ({ name, email }): Promise<{ email: string }> => {
      await tick();
      this.users.add(name, email);
      return { email };
    }
  );

  // Read a committed user back (a fresh request → a fresh fork that queries the DB).
  byEmail = handle(
    "user.byEmail",
    { input: byEmailSchema },
    async ({ email }): Promise<UserView | null> => {
      const user = await this.users.findByEmail(email);
      return user ? { id: user.id, name: user.name, email: user.email } : null;
    }
  );

  // Mutate an existing user — dirty-tracked, committed at request end, no `.save()`.
  rename = handle(
    "user.rename",
    { input: renameSchema },
    async ({ email, name }): Promise<{ email: string }> => {
      await this.users.rename(email, name);
      return { email };
    }
  );

  // Persist, then throw: the pipeline returns `{ ok: false }`, so the interceptor never flushes and
  // the staged insert is dropped with the request's fork — nothing is written.
  addThenFail = handle(
    "user.addThenFail",
    { input: addSchema },
    async ({ name, email }): Promise<never> => {
      await tick();
      this.users.add(name, email);
      throw new Error("boom: this request must persist nothing");
    }
  );
}
