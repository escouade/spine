import { createRequire } from "node:module";
import type { Options } from "@mikro-orm/core";

// A synchronous resolver bound to THIS module's location, so the optional peer is looked up from
// `@spinejs/mikro-orm`'s own dependency tree. `initSync` (the ORM factory) is synchronous, so the
// extension must load synchronously too — a dynamic `import()` would not fit.
const requireFrom = createRequire(import.meta.url);

/**
 * Loads the `Migrator` extension class from the optional peer `@mikro-orm/migrations`.
 *
 * Called at configure time **only** when a connection declares a `migrations` block — so an app that
 * never migrates neither installs nor imports the package (NFR-4, AD-9). Registering the extension
 * explicitly (`extensions: [Migrator]`) means `orm.getMigrator()` resolves from the registered
 * extension rather than MikroORM's runtime require fallback (AD-2), and a **missing** package surfaces
 * as an actionable error at **boot** rather than an opaque failure at the first `getMigrator()` call
 * (AD-9).
 *
 * `req` is injectable purely for testing the missing-dependency path without uninstalling the package.
 */
export function loadMigratorExtension(
  req: NodeRequire = requireFrom
): NonNullable<Options["extensions"]>[number] {
  let mod: { Migrator?: unknown };
  try {
    mod = req("@mikro-orm/migrations") as { Migrator?: unknown };
  } catch (err) {
    // Only remap a genuine "the package isn't installed" failure to the install hint. Any other error
    // — a version-skew throw at import, a corrupt install, a *transitive* module not found — must
    // surface as-is, or the developer chases a phantom reinstall of an already-present package.
    const e = err as { code?: string; message?: string };
    const notFound =
      e?.code === "MODULE_NOT_FOUND" ||
      /cannot find module/i.test(String(e?.message));
    if (notFound && /@mikro-orm\/migrations/.test(String(e?.message))) {
      throw new Error(
        "@spinejs/mikro-orm: a `migrations` block is configured but the optional peer dependency " +
          "`@mikro-orm/migrations` is not installed. Install it at the same major as `@mikro-orm/core` " +
          "(`@mikro-orm/migrations@^6`) — e.g. `npm i -D @mikro-orm/migrations@^6`."
      );
    }
    throw err;
  }
  // The package resolved but is missing the expected export (e.g. a mismatched major) — fail loudly
  // rather than pushing `undefined` into `extensions` and deferring a confusing error.
  if (!mod?.Migrator) {
    throw new Error(
      "@spinejs/mikro-orm: `@mikro-orm/migrations` resolved but did not export `Migrator`. Ensure it " +
        "matches your `@mikro-orm/core` major (`@mikro-orm/migrations@^6`)."
    );
  }
  return mod.Migrator as NonNullable<Options["extensions"]>[number];
}
