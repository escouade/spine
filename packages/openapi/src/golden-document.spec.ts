import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Validator } from "@seriousme/openapi-schema-validator";
import { buildOpenApiDocument } from "./build-document";
import type { BuildDocumentConfig } from "./build-document";
import { fixtureRoutes } from "./__fixtures__/example-app";

/**
 * Story 1.8 — the builder LOCK over the complete `example-app` fixture.
 *
 * This is not the first test of the builder: each builder story (1.3–1.7) unit-tested its own slice
 * in `build-document.spec.ts`. This file locks the *whole* assembled document: byte-identical output
 * (AD-6, NFR-5) and OpenAPI-3.1 validity (NFR-6). The shape of the underlying zod fragments is locked
 * separately in `zod-pin-guard.spec.ts` (R5).
 */

const config: BuildDocumentConfig = {
  info: { title: "Example", version: "1.0.0" },
};

const goldenPath = fileURLToPath(
  new URL("./__fixtures__/example-app.openapi.json", import.meta.url)
);

/** The canonical serialization the golden file is written with (2-space, trailing newline). */
function serialize(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

describe("golden document (AD-6, NFR-5)", () => {
  it("matches the committed golden file byte-for-byte", () => {
    const built = serialize(buildOpenApiDocument(fixtureRoutes(), config));
    // `UPDATE_GOLDEN=1 yarn test` regenerates the lock; it is never hand-edited.
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(goldenPath, built);
    }
    const golden = readFileSync(goldenPath, "utf8");
    expect(built).toBe(golden);
  });

  it("is byte-identical across two independent builds", () => {
    // Two fresh `fixtureRoutes()` calls → fresh controller instances, fresh guard instances, fresh
    // registry. Reusing one `routes` array would not catch map-iteration-order leakage, which is
    // exactly what AD-6 forbids ("no map-iteration-order leakage").
    const a = serialize(buildOpenApiDocument(fixtureRoutes(), config));
    const b = serialize(buildOpenApiDocument(fixtureRoutes(), config));
    expect(a).toBe(b);
  });
});

describe("OpenAPI 3.1 validity (NFR-6)", () => {
  it("advertises OpenAPI 3.1 support", () => {
    expect(Validator.supportedVersions.has("3.1")).toBe(true);
  });

  it("passes an OpenAPI 3.1 validator with zero errors", async () => {
    const doc = buildOpenApiDocument(fixtureRoutes(), config);
    const validator = new Validator();
    const { valid, errors } = await validator.validate(
      doc as unknown as object
    );
    // Surface any validator errors in the failure message.
    expect(valid, JSON.stringify(errors, null, 2)).toBe(true);
    // The document declares `openapi: "3.1.0"`, so the validator validates it against the 3.1 schema.
    expect(validator.version).toBe("3.1");
  });
});
