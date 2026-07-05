import { z } from "zod/v4";
import { Controller, getRoutes } from "@spinejs/gateway-core";
import type {
  GatewayContext,
  Guard,
  GuardConstructor,
} from "@spinejs/gateway-core";
import {
  DefaultHttpErrorMapper,
  HttpGateway,
  ZodValidator,
  del,
  get,
  post,
} from "@spinejs/http-gateway";
import type {
  HttpBaseContext,
  HttpRaw,
  HttpRoute,
} from "@spinejs/http-gateway";

/**
 * Shared example-app fixture for the builder stories (1.3–1.7). Each builder story adds the routes it
 * needs and its own assertions; Story 1.8 golden-file-locks the whole thing. Kept SSE-free until
 * Story 1.6 introduces the SSE branch. Schemas are authored with `zod/v4` (the converter's flavor).
 */

@Controller({})
class UsersController {
  list = get(
    "/users",
    { query: z.object({ page: z.number().optional(), q: z.string() }) },
    () => ({ ok: true })
  );

  create = post(
    "/users",
    {
      body: z.object({ name: z.string(), email: z.string() }),
      successStatus: 201,
      summary: "Create a user",
      tags: ["users"],
    },
    () => ({ ok: true })
  );

  find = get(
    "/users/:id",
    {
      params: z.object({ id: z.string() }),
      summary: "Find a user",
      description: "Fetch one user by id",
      tags: ["users"],
      operationId: "findUser",
      deprecated: true,
      // Author supplies examples — the builder must NOT surface them at operation level (Story 1.5).
      examples: { sample: { value: { id: "1" } } },
    },
    () => ({ ok: true })
  );

  remove = del("/users/:id", { params: z.object({ id: z.string() }) }, () => ({
    ok: true,
  }));
}

@Controller({})
class HealthController {
  ping = get("/health", {}, () => ({ ok: true }));
}

@Controller({})
class HiddenController {
  secret = get("/secret", { hidden: true }, () => ({ ok: true }));
}

// Named schemas are module-level consts: zod's `.meta({ id })` registers the id in a process-global
// registry, so re-evaluating it per controller instance would throw "ID already exists".
const Address = z.object({ street: z.string() }).meta({ id: "Address" });
const Product = z.object({ sku: z.string() }).meta({ id: "Product" });

// Recursive schema: zod's `cycles: "ref"` emits a `$ref: "#"` self-reference for `children`, which the
// builder must rewrite to the body's own component (else it dangles at the document root).
interface CategoryNode {
  name: string;
  children: CategoryNode[];
}
const Category: z.ZodType<CategoryNode> = z.object({
  name: z.string(),
  children: z.array(z.lazy(() => Category)),
});

@Controller({})
class CatalogController {
  // Body schema carries `.meta({ id })` → registered under that id.
  createProduct = post("/products", { body: Product }, () => ({ ok: true }));

  // Reuses `Address` twice → a single `Address` component, referenced by `$ref`.
  createOrder = post(
    "/orders",
    { body: z.object({ billing: Address, shipping: Address }) },
    () => ({ ok: true })
  );

  // Discriminated union → `oneOf` + `discriminator.propertyName`.
  createEvent = post(
    "/events",
    {
      body: z.object({
        payload: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("click"), x: z.number() }),
          z.object({ kind: z.literal("view"), url: z.string() }),
        ]),
      }),
    },
    () => ({ ok: true })
  );

  // Recursive body → the component references itself, never a bare `$ref: "#"`.
  createCategory = post("/categories", { body: Category }, () => ({
    ok: true,
  }));
}

const contextFactory = {
  create: (honoCtx: HttpRaw): HttpBaseContext => ({ honoCtx }),
};

const noGuards = new Map<GuardConstructor, Guard<GatewayContext>>();

/**
 * Assemble the fixture controllers into `readonly HttpRoute[]` through a real `HttpGateway`, so the
 * builder reads them off the same `routes` accessor a live app exposes (exercises AD-4 end-to-end).
 */
export function fixtureRoutes(): readonly HttpRoute[] {
  const gateway = new HttpGateway(
    new ZodValidator(),
    new DefaultHttpErrorMapper(),
    contextFactory
  );
  gateway.register(getRoutes(new UsersController(), noGuards) as HttpRoute[]);
  gateway.register(getRoutes(new HealthController(), noGuards) as HttpRoute[]);
  gateway.register(getRoutes(new HiddenController(), noGuards) as HttpRoute[]);
  gateway.register(getRoutes(new CatalogController(), noGuards) as HttpRoute[]);
  return gateway.routes;
}
