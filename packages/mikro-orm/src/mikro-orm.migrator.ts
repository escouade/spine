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
  try {
    return (req("@mikro-orm/migrations") as { Migrator: unknown })
      .Migrator as NonNullable<Options["extensions"]>[number];
  } catch {
    throw new Error(
      "@spinejs/mikro-orm: a `migrations` block is configured but the optional peer dependency " +
        "`@mikro-orm/migrations` is not installed. Install it at the same major as `@mikro-orm/core` " +
        "(`@mikro-orm/migrations@^6`) — e.g. `npm i -D @mikro-orm/migrations@^6`."
    );
  }
}
