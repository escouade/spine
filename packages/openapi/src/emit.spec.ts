import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { buildOpenApiDocument } from "./build-document";
import type { BuildDocumentConfig } from "./build-document";
import { emitOpenApiDocument, renderOpenApiDocument } from "./emit";
import { fixtureRoutes } from "./__fixtures__/example-app";

/**
 * Story 2.1 — the file-emit helper and its shared render layer.
 *
 * JSON rendering must be byte-identical to Story 1.8's golden serialization (emission and serving share
 * one convention). YAML is locked with its own golden (`example-app.openapi.yaml`) + `UPDATE_GOLDEN=1`
 * regen, mirroring `golden-document.spec.ts` — this owns the "YAML rendering preserves this ordering"
 * half of AD-6 that 1.8 explicitly deferred here.
 */

const config: BuildDocumentConfig = {
  info: { title: "Example", version: "1.0.0" },
};

const jsonGoldenPath = fileURLToPath(
  new URL("./__fixtures__/example-app.openapi.json", import.meta.url)
);
const yamlGoldenPath = fileURLToPath(
  new URL("./__fixtures__/example-app.openapi.yaml", import.meta.url)
);

describe("renderOpenApiDocument — JSON (AD-5, shared with serving)", () => {
  it("byte-matches the committed golden JSON (same serialization as Story 1.8)", () => {
    const rendered = renderOpenApiDocument(
      buildOpenApiDocument(fixtureRoutes(), config),
      "json"
    );
    expect(rendered).toBe(readFileSync(jsonGoldenPath, "utf8"));
  });
});

describe("renderOpenApiDocument — YAML (AD-6 ordering)", () => {
  it("matches the committed golden YAML byte-for-byte", () => {
    const rendered = renderOpenApiDocument(
      buildOpenApiDocument(fixtureRoutes(), config),
      "yaml"
    );
    // `UPDATE_GOLDEN=1 yarn test` regenerates the lock; it is never hand-edited.
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(yamlGoldenPath, rendered);
    }
    expect(rendered).toBe(readFileSync(yamlGoldenPath, "utf8"));
  });

  it("is byte-identical across two independent builds", () => {
    // Two fresh `fixtureRoutes()` calls → fresh instances, fresh registry. Reusing one `routes` array would
    // not catch map-iteration-order leakage, which AD-6 forbids ("no map-iteration-order leakage").
    const a = renderOpenApiDocument(
      buildOpenApiDocument(fixtureRoutes(), config),
      "yaml"
    );
    const b = renderOpenApiDocument(
      buildOpenApiDocument(fixtureRoutes(), config),
      "yaml"
    );
    expect(a).toBe(b);
  });

  it("round-trips: parsing the YAML deep-equals the built document", () => {
    const doc = buildOpenApiDocument(fixtureRoutes(), config);
    const parsed = parse(renderOpenApiDocument(doc, "yaml"));
    // `JSON.parse(JSON.stringify(doc))` drops `undefined`-only keys so the comparison is against the
    // JSON-safe projection (AD-14) the YAML also encodes.
    expect(parsed).toEqual(JSON.parse(JSON.stringify(doc)));
  });

  it("preserves path key order (AD-6 sorted paths survive YAML)", () => {
    const doc = buildOpenApiDocument(fixtureRoutes(), config);
    const parsed = parse(renderOpenApiDocument(doc, "yaml")) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(parsed.paths)).toEqual(Object.keys(doc.paths));
  });

  it("emits no YAML anchors or aliases for shared $ref fragments", () => {
    const yaml = renderOpenApiDocument(
      buildOpenApiDocument(fixtureRoutes(), config),
      "yaml"
    );
    // The envelope/error components are shared object references; `aliasDuplicateObjects: false` must keep
    // them expanded rather than emitting `&anchor` / `*alias` (which would be valid YAML but tool-fragile).
    expect(yaml).not.toMatch(/(^|\s)[&*][A-Za-z0-9_]/m);
  });

  it("ends with a single trailing newline", () => {
    const yaml = renderOpenApiDocument(
      buildOpenApiDocument(fixtureRoutes(), config),
      "yaml"
    );
    expect(yaml.endsWith("\n")).toBe(true);
    expect(yaml.endsWith("\n\n")).toBe(false);
  });
});

describe("emitOpenApiDocument — file I/O (FR-E1)", () => {
  async function tmpDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), "spine-openapi-emit-"));
  }

  it("writes JSON matching the render, creating missing parent dirs, and returns the absolute path", async () => {
    const doc = buildOpenApiDocument(fixtureRoutes(), config);
    // Nested, un-created path exercises `mkdir(..., { recursive: true })`.
    const out = join(await tmpDir(), "nested", "deep", "openapi.json");
    const written = await emitOpenApiDocument(doc, { out });
    expect(written).toBe(out);
    await expect(stat(written)).resolves.toBeDefined();
    expect(await readFile(written, "utf8")).toBe(
      renderOpenApiDocument(doc, "json")
    );
  });

  it("writes YAML matching the render", async () => {
    const doc = buildOpenApiDocument(fixtureRoutes(), config);
    const out = join(await tmpDir(), "openapi.yaml");
    await emitOpenApiDocument(doc, { out });
    expect(await readFile(out, "utf8")).toBe(
      renderOpenApiDocument(doc, "yaml")
    );
  });

  it("infers format from the extension (.json / .yaml / .yml)", async () => {
    const doc = buildOpenApiDocument(fixtureRoutes(), config);
    const dir = await tmpDir();
    const asJson = await emitOpenApiDocument(doc, {
      out: join(dir, "spec.json"),
    });
    const asYaml = await emitOpenApiDocument(doc, {
      out: join(dir, "spec.yaml"),
    });
    const asYml = await emitOpenApiDocument(doc, {
      out: join(dir, "spec.yml"),
    });
    expect(await readFile(asJson, "utf8")).toBe(
      renderOpenApiDocument(doc, "json")
    );
    expect(await readFile(asYaml, "utf8")).toBe(
      renderOpenApiDocument(doc, "yaml")
    );
    expect(await readFile(asYml, "utf8")).toBe(
      renderOpenApiDocument(doc, "yaml")
    );
  });

  it("lets an explicit format override the extension", async () => {
    const doc = buildOpenApiDocument(fixtureRoutes(), config);
    // `.txt` would be unknown, but an explicit format is authoritative.
    const out = join(await tmpDir(), "spec.txt");
    await emitOpenApiDocument(doc, { out, format: "yaml" });
    expect(await readFile(out, "utf8")).toBe(
      renderOpenApiDocument(doc, "yaml")
    );
  });

  it("throws on an unknown extension with no explicit format (fail fast, no silent default)", async () => {
    const doc = buildOpenApiDocument(fixtureRoutes(), config);
    const out = join(await tmpDir(), "spec.txt");
    await expect(emitOpenApiDocument(doc, { out })).rejects.toThrow(
      /infer OpenAPI emit format/
    );
  });

  it("throws a clear error on an empty `out` path (even with an explicit format)", async () => {
    const doc = buildOpenApiDocument(fixtureRoutes(), config);
    await expect(
      emitOpenApiDocument(doc, { out: "", format: "json" })
    ).rejects.toThrow(/non-empty `out` path/);
  });
});
