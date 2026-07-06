import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { stringify } from "yaml";
import type { OpenApiDocument } from "./types";

/**
 * Output serialization for the OpenAPI document — the file-emit and live-serving consumers share it (AD-5).
 */
export type EmitFormat = "json" | "yaml";

/** Options for {@link emitOpenApiDocument}. */
export interface EmitOpenApiDocumentOptions {
  /** Destination file path. Missing parent directories are created. */
  out: string;
  /**
   * Output format. Inferred from the `out` extension (`.json` → `json`, `.yaml`/`.yml` → `yaml`) when
   * omitted; an explicit value overrides the extension. An unknown extension with no explicit format throws.
   */
  format?: EmitFormat;
}

/**
 * Render an OpenAPI document to a string — pure, no I/O (AD-5 "one pure builder, three consumers": this is
 * the shared YAML/JSON rendering layer, reused by file emission here and by live serving in Epic 3).
 *
 * `json` is byte-identical to the golden serialization (`JSON.stringify(doc, null, 2)` + trailing newline,
 * matching Story 1.8's `golden-document.spec.ts`). `yaml` preserves the document's key order (AD-6 "YAML
 * rendering preserves this ordering") and emits no anchors/aliases for the shared `$ref` fragment objects.
 */
export function renderOpenApiDocument(
  doc: OpenApiDocument,
  format: EmitFormat
): string {
  if (format === "json") {
    return `${JSON.stringify(doc, null, 2)}\n`;
  }
  // `aliasDuplicateObjects: false` — the builder's component registry reuses fragment objects; the default
  // (`true`) would emit `&anchor`/`*alias` for them, producing noisy, tool-fragile output. `lineWidth: 0`
  // disables fold-wrapping so a node stays on one line and diffs stay local (the point of file emission).
  // `.trimEnd() + "\n"` pins exactly one trailing newline — symmetric with the JSON branch, so the byte
  // golden (AD-6) never depends on `yaml`'s default trailing-whitespace behavior across a version bump.
  return `${stringify(doc, {
    aliasDuplicateObjects: false,
    lineWidth: 0,
  }).trimEnd()}\n`;
}

/** Map a file extension to its {@link EmitFormat}, or `undefined` when it is not a recognized spec extension. */
function formatFromExtension(path: string): EmitFormat | undefined {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    default:
      return undefined;
  }
}

/**
 * Write an already-built OpenAPI document to disk as one file (FR-E1). It never rebuilds the document —
 * the caller passes the output of `buildOpenApiDocument`, so the file can never disagree with live serving
 * (FR-E4, AD-5). Emitting both JSON and YAML is two calls (the CLI composes them); the helper stays
 * single-purpose. Missing parent directories are created. Returns the absolute path written.
 */
export async function emitOpenApiDocument(
  doc: OpenApiDocument,
  options: EmitOpenApiDocumentOptions
): Promise<string> {
  if (!options.out) {
    throw new Error("emitOpenApiDocument requires a non-empty `out` path.");
  }

  const format = options.format ?? formatFromExtension(options.out);
  if (!format) {
    throw new Error(
      `Cannot infer OpenAPI emit format from "${options.out}": expected a .json, .yaml, or .yml extension, or an explicit \`format\` option.`
    );
  }

  const outPath = resolve(options.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, renderOpenApiDocument(doc, format), "utf8");
  return outPath;
}
