import { describe, expect, it } from "vitest";
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
  get,
  sse,
} from "@spinejs/http-gateway";
import type {
  HttpBaseContext,
  HttpRaw,
  HttpRoute,
} from "@spinejs/http-gateway";
import { buildOpenApiDocument } from "./build-document";
import type { BuildDocumentConfig } from "./build-document";
import { fixtureRoutes } from "./__fixtures__/example-app";

const config: BuildDocumentConfig = {
  info: { title: "Example", version: "1.0.0" },
};

function build(overrides: Partial<BuildDocumentConfig> = {}) {
  return buildOpenApiDocument(fixtureRoutes(), { ...config, ...overrides });
}

// Local helpers to read the JSON-safe document without `any`.
type Op = Record<string, unknown>;
function paths(
  doc: ReturnType<typeof build>
): Record<string, Record<string, Op>> {
  return doc.paths as unknown as Record<string, Record<string, Op>>;
}

describe("buildOpenApiDocument", () => {
  it("emits a 3.1 document envelope with configured info", () => {
    const doc = build();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info).toEqual({ title: "Example", version: "1.0.0" });
  });

  it("maps each route to a path item / operation and converts :param to {param}", () => {
    const p = paths(build());
    expect(Object.keys(p)).toContain("/users");
    expect(Object.keys(p)).toContain("/users/{id}");
    expect(p["/users"].get).toBeDefined();
    expect(p["/users"].post).toBeDefined();
    expect(p["/users/{id}"].get).toBeDefined();
    expect(p["/users/{id}"].delete).toBeDefined();
  });

  it("omits hidden routes (AD-13)", () => {
    const p = paths(build());
    expect(Object.keys(p)).not.toContain("/secret");
  });

  it("omits routes matched by the exclude list (AD-13, OR precedence)", () => {
    const p = paths(build({ exclude: ["/users"] }));
    expect(Object.keys(p)).not.toContain("/users");
    // /users/:id is a different path and stays.
    expect(Object.keys(p)).toContain("/users/{id}");
  });

  it("decomposes params into required path parameters", () => {
    const op = paths(build())["/users/{id}"].get;
    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
  });

  it("decomposes query into query parameters with correct required flags", () => {
    const params = paths(build())["/users"].get.parameters as Array<
      Record<string, unknown>
    >;
    // Sorted by name for determinism: page (optional) then q (required).
    expect(params.map((x) => x.name)).toEqual(["page", "q"]);
    const page = params.find((x) => x.name === "page");
    const q = params.find((x) => x.name === "q");
    expect(page).toMatchObject({ in: "query", required: false });
    expect(q).toMatchObject({ in: "query", required: true });
  });

  it("maps body to an application/json requestBody", () => {
    const op = paths(build())["/users"].post;
    expect(op.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: { type: "object", properties: { name: {}, email: {} } },
        },
      },
    });
  });

  it("populates doc metadata and honours an explicit operationId", () => {
    const op = paths(build())["/users/{id}"].get;
    expect(op).toMatchObject({
      summary: "Find a user",
      description: "Fetch one user by id",
      tags: ["users"],
      operationId: "findUser",
      deprecated: true,
    });
  });

  it("derives a deterministic operationId when none is given", () => {
    const p = paths(build());
    expect(p["/health"].get.operationId).toBe("getHealth");
    expect(p["/users"].get.operationId).toBe("getUsers");
    expect(p["/users/{id}"].delete.operationId).toBe("deleteUsersById");
  });

  it("emits a minimal responses placeholder (default 200, successStatus honoured)", () => {
    const p = paths(build());
    expect(p["/users"].get.responses).toEqual({ "200": { description: "OK" } });
    expect(p["/users"].post.responses).toEqual({
      "201": { description: "OK" },
    });
  });

  it("never emits an operation-level examples field (not valid in 3.1)", () => {
    const op = paths(build())["/users/{id}"].get;
    expect(op.examples).toBeUndefined();
  });

  it("is deterministic: paths sorted lexically, verbs in GET,POST,PUT,PATCH,DELETE order", () => {
    const doc = build();
    const keys = Object.keys(doc.paths);
    expect(keys).toEqual([...keys].sort());
    // /users has get before post.
    expect(Object.keys(paths(doc)["/users"])).toEqual(["get", "post"]);
    // Two builds are deep-equal (AD-6; byte-lock is Story 1.8).
    expect(build()).toEqual(build());
  });

  it("skips SSE routes (documented in Story 1.6)", () => {
    @Controller({})
    class StreamController {
      stream = sse("/stream", {}, async function* () {});
      plain = get("/plain", {}, () => ({ ok: true }));
    }
    const contextFactory = {
      create: (honoCtx: HttpRaw): HttpBaseContext => ({ honoCtx }),
    };
    const noGuards = new Map<GuardConstructor, Guard<GatewayContext>>();
    const gateway = new HttpGateway(
      new ZodValidator(),
      new DefaultHttpErrorMapper(),
      contextFactory
    );
    gateway.register(
      getRoutes(new StreamController(), noGuards) as HttpRoute[]
    );

    const doc = buildOpenApiDocument(gateway.routes, config);
    expect(Object.keys(doc.paths)).toEqual(["/plain"]);
  });
});
