import { describe, expect, it } from "vitest";
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
  get,
  post,
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
function components(doc: ReturnType<typeof build>): Record<string, Op> {
  return (
    (doc.components as { schemas?: Record<string, Op> } | undefined)?.schemas ??
    {}
  );
}

const contextFactory = {
  create: (honoCtx: HttpRaw): HttpBaseContext => ({ honoCtx }),
};
const noGuards = new Map<GuardConstructor, Guard<GatewayContext>>();

/** Build a document from a single ad-hoc controller instance (for isolated edge-case routes). */
function docFromController(controller: object) {
  const gateway = new HttpGateway(
    new ZodValidator(),
    new DefaultHttpErrorMapper(),
    contextFactory
  );
  gateway.register(getRoutes(controller, noGuards) as HttpRoute[]);
  return buildOpenApiDocument(gateway.routes, config);
}

// A named response schema (unique id — module-level so zod's global `.meta` registry sees it once).
const NamedResponse = z.object({ v: z.string() }).meta({ id: "NamedResponse" });

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

  it("registers the body as a component and $refs it (AD-8)", () => {
    const doc = build();
    const op = paths(doc)["/users"].post;
    expect(op.requestBody).toMatchObject({
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/PostUsers_Body" },
        },
      },
    });
    expect(components(doc).PostUsers_Body).toMatchObject({
      type: "object",
      properties: { name: {}, email: {} },
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

  it("wraps a data-less success in a named envelope at successStatus (AD-7)", () => {
    const p = paths(build());
    // No `response` schema → `{ ok: true }` envelope component, referenced (never inlined).
    expect(p["/users"].get.responses).toEqual({
      "200": {
        description: "OK",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/GetUsers_ResponseEnvelope" },
          },
        },
      },
    });
    // successStatus is honoured (201 for the creation).
    expect(p["/users"].post.responses).toEqual({
      "201": {
        description: "OK",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/PostUsers_ResponseEnvelope" },
          },
        },
      },
    });
    expect(components(build()).GetUsers_ResponseEnvelope).toEqual({
      type: "object",
      properties: { ok: { const: true } },
      required: ["ok"],
    });
  });

  it("wraps a `response` schema as `{ ok: true, data: $ref }` over a named inner component (AC #1)", () => {
    const doc = build();
    const ok = paths(doc)["/reports/{id}"].get.responses as Record<string, Op>;
    expect(ok["200"]).toMatchObject({
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/GetReportsById_ResponseEnvelope",
          },
        },
      },
    });
    // Envelope references the inner data component; the raw schema is never inlined unwrapped.
    expect(components(doc).GetReportsById_ResponseEnvelope).toEqual({
      type: "object",
      properties: {
        ok: { const: true },
        data: { $ref: "#/components/schemas/GetReportsById_Response" },
      },
      required: ["ok", "data"],
    });
    expect(components(doc).GetReportsById_Response).toEqual({
      type: "object",
      properties: { id: { type: "string" }, total: { type: "number" } },
      required: ["id", "total"],
      additionalProperties: false,
    });
  });

  it("declares static headers on the success response only, as `const` schemas (AC #2)", () => {
    const doc = build();
    const ok = paths(doc)["/reports/{id}"].get.responses as Record<string, Op>;
    expect(ok["200"].headers).toEqual({
      "X-Total-Count": { schema: { const: "0" } },
    });
    // Not on the error / extra responses.
    expect(ok["404"].headers).toBeUndefined();
    expect(ok["202"].headers).toBeUndefined();
  });

  it("surfaces author examples at the response media type, never at operation level (AC #4)", () => {
    const doc = build();
    const op = paths(doc)["/reports/{id}"].get;
    expect(op.examples).toBeUndefined();
    const ok = op.responses as Record<string, Op>;
    const media = (ok["200"].content as Record<string, Op>)["application/json"];
    expect(media.examples).toEqual({
      sample: { value: { ok: true, data: { id: "1", total: 3 } } },
    });
  });

  it("emits one shared, deduplicated `ErrorResponse` component for mapped errors (AD-7/AD-8)", () => {
    const doc = build();
    const c = components(doc);
    expect(c.ErrorResponse).toEqual({
      type: "object",
      properties: { ok: { const: false }, code: { type: "string" } },
      required: ["ok", "code"],
    });
    // Deduped: never suffixed, even though two routes declare a 404 error.
    expect(c.ErrorResponse_2).toBeUndefined();
    const a = (paths(doc)["/reports/{id}"].get.responses as Record<string, Op>)[
      "404"
    ];
    const b = (
      paths(doc)["/reports/{id}/archive"].post.responses as Record<string, Op>
    )["404"];
    const refOf = (r: Op) =>
      ((r.content as Record<string, Op>)["application/json"].schema as Op).$ref;
    expect(refOf(a)).toBe("#/components/schemas/ErrorResponse");
    expect(refOf(b)).toBe("#/components/schemas/ErrorResponse");
  });

  it("documents each extra status in ascending order, wrapping success bodies and errors (AC #3)", () => {
    const doc = build();
    const responses = paths(doc)["/reports/{id}"].get.responses as Record<
      string,
      Op
    >;
    // successStatus + responses-map keys, ascending numeric.
    expect(Object.keys(responses)).toEqual(["200", "202", "404"]);
    // 202 extra success → its own envelope over an inner component.
    expect(responses["202"]).toEqual({
      description: "Accepted",
      content: {
        "application/json": {
          schema: {
            $ref: "#/components/schemas/GetReportsById_ResponseEnvelope202",
          },
        },
      },
    });
    // 404 error → shared component; explicit doc description wins.
    expect(responses["404"].description).toBe("No such report");
  });

  it("falls back to `Error (<code>)` when a mapped error has no description", () => {
    const responses = paths(build())["/reports/{id}/archive"].post
      .responses as Record<string, Op>;
    expect(responses["404"].description).toBe("Error (REPORT_NOT_FOUND)");
  });

  it("converts response schemas with io:output (FR-C6)", () => {
    @Controller({})
    class OutController {
      read = get(
        "/out",
        {
          response: z.object({
            n: z.string(),
            ready: z.boolean().default(false),
          }),
        },
        () => ({ ok: true })
      );
    }
    const doc = docFromController(new OutController());
    const inner = components(doc).GetOut_Response as { required?: string[] };
    // On the output side a `.default()` field is always present → required (input would omit it).
    expect(inner.required).toContain("ready");
  });

  it("names a response's inner component from its `.meta({ id })` and the envelope refs it (AD-8)", () => {
    @Controller({})
    class NamedController {
      read = get("/named", { response: NamedResponse }, () => ({ ok: true }));
    }
    const doc = docFromController(new NamedController());
    // Inner data component keeps the authored id (like a body), not a derived `<opId>_Response`.
    expect(components(doc).NamedResponse).toEqual({
      type: "object",
      properties: { v: { type: "string" } },
      required: ["v"],
      additionalProperties: false,
    });
    expect(components(doc).GetNamed_Response).toBeUndefined();
    const envelope = components(doc).GetNamed_ResponseEnvelope as {
      properties: { data: { $ref?: string } };
    };
    expect(envelope.properties.data.$ref).toBe(
      "#/components/schemas/NamedResponse"
    );
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

  it("documents an SSE route as a text/event-stream GET, un-enveloped (AD-15)", () => {
    @Controller({})
    class StreamController {
      stream = sse("/stream", {}, async function* () {});
      plain = get("/plain", {}, () => ({ ok: true }));
    }
    const doc = docFromController(new StreamController());
    // No longer skipped — the SSE route is documented alongside the plain one.
    expect(Object.keys(doc.paths)).toEqual(["/plain", "/stream"]);
    const op = (doc.paths as Record<string, Record<string, Op>>)["/stream"].get;
    // GET, text/event-stream success, no application/json, no request body, no envelope.
    expect(op.requestBody).toBeUndefined();
    expect(op.responses).toEqual({
      "200": {
        description: "Server-sent event stream",
        content: { "text/event-stream": { schema: { type: "string" } } },
      },
    });
    // SSE never synthesizes a response envelope component.
    expect(components(doc).GetStream_ResponseEnvelope).toBeUndefined();
  });

  it("maps an SSE route's query into parameters (FR-B1, AC #2)", () => {
    const op = paths(build())["/stream"].get;
    expect(op.parameters).toEqual([
      {
        name: "since",
        in: "query",
        required: false,
        schema: { type: "string" },
      },
    ]);
  });

  it("declares static headers on an SSE response (AD-15)", () => {
    @Controller({})
    class HeadedStream {
      stream = sse(
        "/hs",
        { headers: { "X-Stream": "1" } },
        async function* () {}
      );
    }
    const doc = docFromController(new HeadedStream());
    const op = (doc.paths as Record<string, Record<string, Op>>)["/hs"].get;
    const ok = (op.responses as Record<string, Op>)["200"];
    expect(ok.headers).toEqual({ "X-Stream": { schema: { const: "1" } } });
    expect(
      (ok.content as Record<string, Op>)["text/event-stream"]
    ).toBeDefined();
  });

  it("maps an SSE route's path params as required parameters (AC #2)", () => {
    @Controller({})
    class JobStream {
      stream = sse(
        "/jobs/:id/stream",
        { params: z.object({ id: z.string() }) },
        async function* () {}
      );
    }
    const doc = docFromController(new JobStream());
    const op = (doc.paths as Record<string, Record<string, Op>>)[
      "/jobs/{id}/stream"
    ].get;
    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
    // Still an un-enveloped event stream.
    expect((op.responses as Record<string, Op>)["200"]).toMatchObject({
      content: { "text/event-stream": { schema: { type: "string" } } },
    });
  });

  it("leaves normal (non-SSE) routes enveloped as application/json (AC #3)", () => {
    const ok = (paths(build())["/health"].get.responses as Record<string, Op>)[
      "200"
    ];
    expect(Object.keys(ok.content as object)).toEqual(["application/json"]);
  });

  it("does not surface author-provided examples at operation level", () => {
    // The fixture's `findUser` route DOES set `examples` in its meta — the operation must still omit it.
    const op = paths(build())["/users/{id}"].get;
    expect(op.examples).toBeUndefined();
  });

  it("synthesizes a required path parameter for a :param route with no params schema", () => {
    @Controller({})
    class WidgetsController {
      find = get("/widgets/:id", {}, () => ({ ok: true }));
    }
    const doc = docFromController(new WidgetsController());
    const op = (doc.paths as Record<string, Record<string, Op>>)[
      "/widgets/{id}"
    ].get;
    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
  });

  it("strips the $schema dialect marker from the registered component", () => {
    @Controller({})
    class ThingsController {
      create = post(
        "/things",
        { body: z.object({ name: z.string() }) },
        () => ({
          ok: true,
        })
      );
    }
    const doc = docFromController(new ThingsController());
    const component = components(doc).PostThings_Body;
    expect(component.$schema).toBeUndefined();
    expect(component.type).toBe("object");
  });

  it("names a body component from its .meta({ id }) (AD-8, authored id)", () => {
    const doc = build();
    const op = paths(doc)["/products"].post;
    expect(op.requestBody).toMatchObject({
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/Product" },
        },
      },
    });
    // The parasite `id` key from `.meta` is stripped from the component.
    expect(components(doc).Product).toEqual({
      type: "object",
      properties: { sku: { type: "string" } },
      required: ["sku"],
    });
  });

  it("relocates a reused schema to one shared component with no dangling $ref (AD-8)", () => {
    const doc = build();
    const serialized = JSON.stringify(doc);
    expect(serialized).not.toContain("#/$defs/");
    expect(serialized).not.toContain('"$defs"');
    // The reused `Address` (a .meta id schema) is a single component, referenced by both fields.
    const order = components(doc).PostOrders_Body as {
      properties: Record<string, { $ref?: string }>;
    };
    expect(order.properties.billing.$ref).toBe("#/components/schemas/Address");
    expect(order.properties.shipping.$ref).toBe("#/components/schemas/Address");
    expect(components(doc).Address).toBeDefined();
  });

  it("rewrites a discriminated union to oneOf + discriminator (FR-C4)", () => {
    const doc = build();
    const body = components(doc).PostEvents_Body as {
      properties: Record<string, Record<string, unknown>>;
    };
    const payload = body.properties.payload;
    expect(payload.anyOf).toBeUndefined();
    expect(Array.isArray(payload.oneOf)).toBe(true);
    expect(payload.discriminator).toEqual({ propertyName: "kind" });
  });

  it('rewrites a recursive body\'s `$ref: "#"` to its own component, never a bare self-ref', () => {
    const doc = build();
    // No document-root self-reference survives anywhere in the emitted document.
    expect(JSON.stringify(doc)).not.toContain('"$ref":"#"');
    const category = components(doc).PostCategories_Body as {
      properties: { children: { items: { $ref?: string } } };
    };
    expect(category.properties.children.items.$ref).toBe(
      "#/components/schemas/PostCategories_Body"
    );
  });

  it("emits components in sorted key order (AD-6)", () => {
    const doc = build();
    const keys = Object.keys(components(doc));
    expect(keys).toEqual([...keys].sort());
    expect(keys.length).toBeGreaterThan(0);
  });
});
