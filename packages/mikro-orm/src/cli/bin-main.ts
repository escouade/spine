import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import type { ModuleEntry } from "@spinejs/core";
import { runMigrations } from "./run-migrations";

/**
 * The CLI's collaborators, injectable so the exit-code mapping is unit-testable without a real boot or
 * a spawned process. Defaults wire the real {@link runMigrations}, the real {@link loadAppModule}, and
 * `console.error`.
 */
export interface CliDeps {
  runMigrations: (appModule: ModuleEntry, argv: string[]) => Promise<void>;
  loadAppModule: (spec: string) => Promise<ModuleEntry>;
  logError: (message: string) => void;
}

/**
 * Resolve the user's `AppModule` from a `--module <path>#<Export>` spec — the convenience launcher over
 * the stable `runMigrations(AppModule, argv)` contract (AD-5). The `#<Export>` is optional: it defaults
 * to a `AppModule` named export, then the `default` export, then a sole export; an ambiguous module
 * (several exports, no `#Export`) fails with an actionable message.
 *
 * `AppModule` is tried **before** `default` on purpose: a TypeScript app compiled to **CommonJS** and
 * loaded via `import()` exposes `mod.default` as the whole `module.exports` wrapper object (always
 * defined) — picking it would hand `App` a plain object, not the module class. The named export is the
 * class in both the ESM and CJS builds, so it is the reliable pick; ESM apps that only `export default`
 * still fall through to it.
 */
export async function loadAppModule(spec: string): Promise<ModuleEntry> {
  const hashIdx = spec.lastIndexOf("#");
  const path = hashIdx === -1 ? spec : spec.slice(0, hashIdx);
  const exportName = hashIdx === -1 ? undefined : spec.slice(hashIdx + 1);
  const mod = (await import(pathToFileURL(resolve(path)).href)) as Record<
    string,
    unknown
  >;
  return pickExport(mod, exportName, spec) as ModuleEntry;
}

function pickExport(
  mod: Record<string, unknown>,
  exportName: string | undefined,
  spec: string
): unknown {
  if (exportName) {
    if (!(exportName in mod)) {
      throw new Error(
        `@spinejs/mikro-orm: module "${spec}" has no export "${exportName}".`
      );
    }
    return mod[exportName];
  }
  if (mod.AppModule !== undefined) return mod.AppModule;
  if (mod.default !== undefined) return mod.default;
  const keys = Object.keys(mod).filter((k) => k !== "__esModule");
  if (keys.length === 1) return mod[keys[0]];
  throw new Error(
    keys.length === 0
      ? `@spinejs/mikro-orm: module "${spec}" has no usable exports — export your AppModule (e.g. \`export class AppModule {}\`) and point at it with "<path>#<Export>".`
      : `@spinejs/mikro-orm: "${spec}" exports several members — name the AppModule with ` +
        `"<path>#<Export>" (found: ${keys.join(", ")}).`
  );
}

const defaultDeps: CliDeps = {
  runMigrations,
  loadAppModule,
  logError: (message) => console.error(message),
};

/** Pull `--module <path>#<Export>` (or `--module=...`) out of argv, returning it and the rest verbatim. */
function extractModule(argv: string[]): {
  moduleSpec: string | undefined;
  rest: string[];
} {
  const rest: string[] = [];
  let moduleSpec: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--module") {
      moduleSpec = argv[i + 1];
      i++; // consume the value
      continue;
    }
    if (token.startsWith("--module=")) {
      moduleSpec = token.slice("--module=".length);
      continue;
    }
    rest.push(token);
  }
  return { moduleSpec, rest };
}

/**
 * The `spine-migrate` CLI's core: resolve the `AppModule`, run the verb, and return a process exit code
 * (`0` success / `1` failure) — the **only** place a migration outcome becomes an exit code (AD-5). It
 * never throws: a failure is logged and mapped to `1`, so a failing migration fails a CI build (SM-3,
 * NFR-5) without an unhandled rejection. Kept separate from `bin.ts` so it is unit-testable with fake
 * collaborators.
 */
export async function runCli(
  argv: string[],
  deps: CliDeps = defaultDeps
): Promise<number> {
  try {
    const { moduleSpec, rest } = extractModule(argv);
    if (!moduleSpec) {
      throw new Error(
        `@spinejs/mikro-orm: point the CLI at your AppModule with ` +
          `--module <path>#<Export> (e.g. --module ./dist/app.module.js#AppModule). ` +
          `Programmatically, call runMigrations(AppModule, argv) instead.`
      );
    }
    const appModule = await deps.loadAppModule(moduleSpec);
    await deps.runMigrations(appModule, rest);
    return 0;
  } catch (err) {
    deps.logError(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
