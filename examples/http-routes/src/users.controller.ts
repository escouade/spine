import { z } from "zod";
import { Controller } from "@spinejs/gateway-core";
import { get, post, put, del } from "@spinejs/http-gateway";
import type { HttpBaseContext } from "@spinejs/http-gateway";
import { UsersStore } from "./users.store";
import { AdminGuard } from "./admin.guard";
import { NotFoundError } from "./not-found.error";

const userSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  email: z.string().email(),
  role: z.enum(["admin", "member"]),
});

const listQuerySchema = z.object({
  role: z.enum(["admin", "member"]).optional(),
});

const idParamSchema = z.object({
  id: z.string().uuid(),
});

const createUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(["admin", "member"]).default("member"),
});

const updateUserSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: z.enum(["admin", "member"]).optional(),
});

/**
 * One controller, every HTTP verb, every param source — declared as instance fields (solution A):
 * - `GET /users`        — query string (`?role=admin`)
 * - `GET /users/:id`    — path param
 * - `POST /users`       — JSON body, `successStatus: 201`
 * - `PUT /users/:id`    — JSON body + path param (both surface structured in `input`)
 * - `DELETE /users/:id` — path param, guarded per-route by `AdminGuard` (needs `x-admin: true`)
 *
 * Each route carries a `response` schema in its marker meta, reserved for future OpenAPI generation.
 */
@Controller({ inject: [UsersStore] })
export class UsersController {
  constructor(private readonly users: UsersStore) {}

  list = get(
    "/users",
    { query: listQuerySchema, response: z.array(userSchema) },
    ({ query }) => this.users.list(query.role)
  );

  getById = get(
    "/users/:id",
    { params: idParamSchema, response: userSchema },
    ({ params }) => {
      const user = this.users.get(params.id);
      if (!user) throw new NotFoundError(`User ${params.id} not found`);
      return user;
    }
  );

  create = post(
    "/users",
    { body: createUserSchema, response: userSchema, successStatus: 201 },
    ({ body }) => this.users.create(body)
  );

  update = put(
    "/users/:id",
    { params: idParamSchema, body: updateUserSchema, response: userSchema },
    ({ params, body }) => {
      const updated = this.users.update(params.id, body);
      if (!updated) throw new NotFoundError(`User ${params.id} not found`);
      return updated;
    }
  );

  remove = del(
    "/users/:id",
    {
      params: idParamSchema,
      response: z.object({ deleted: z.boolean() }),
      guards: [AdminGuard],
    },
    ({ params }) => ({ deleted: this.users.delete(params.id) })
  );

  /**
   * Default `ctx` — no annotation, so it is `AppContext` (the registry). `ctx.user`, set by the
   * `AppContextFactory` from the `x-user` header, is typed and available with no factory import.
   */
  whoami = get(
    "/whoami",
    { response: z.object({ user: z.string() }) },
    (_input, ctx) => ({
      user: ctx.user,
    })
  );

  /**
   * `ctx` override — annotated as the transport base `HttpBaseContext`, so this route opts out of the
   * app context (no `ctx.user` here). Proves default and override coexist on the same helpers.
   */
  ping = get(
    "/ping",
    { response: z.object({ ok: z.boolean() }) },
    (_input, ctx: HttpBaseContext) => ({ ok: ctx.honoCtx.req.method === "GET" })
  );
}
