import { randomUUID } from "node:crypto";
import { Injectable } from "@spinejs/core";

export interface User {
  id: string;
  name: string;
  email: string;
  role: "admin" | "member";
}

/** In-memory `User` store, seeded with two rows so `GET /users` returns data out of the box. */
@Injectable()
export class UsersStore {
  private readonly users = new Map<string, User>(
    (
      [
        {
          id: randomUUID(),
          name: "Ada Lovelace",
          email: "ada@example.com",
          role: "admin",
        },
        {
          id: randomUUID(),
          name: "Alan Turing",
          email: "alan@example.com",
          role: "member",
        },
      ] satisfies User[]
    ).map((user) => [user.id, user])
  );

  list(role?: User["role"]): User[] {
    const all = [...this.users.values()];
    return role ? all.filter((u) => u.role === role) : all;
  }

  get(id: string): User | undefined {
    return this.users.get(id);
  }

  create(data: Omit<User, "id">): User {
    const user: User = { id: randomUUID(), ...data };
    this.users.set(user.id, user);
    return user;
  }

  update(id: string, data: Partial<Omit<User, "id">>): User | undefined {
    const existing = this.users.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...data };
    this.users.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.users.delete(id);
  }
}
