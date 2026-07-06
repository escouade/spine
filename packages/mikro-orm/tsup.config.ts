import { defineConfig } from "tsup";
import { tsupConfig } from "../../tsup.base";

// Ship the library barrel plus the `spine-migrate` CLI entry (`src/cli/bin.ts` → `dist/cli/bin.js`,
// referenced by the package's `bin` field). tsup preserves the entry's `#!/usr/bin/env node` shebang.
export default defineConfig(
  tsupConfig({ entry: ["src/index.ts", "src/cli/bin.ts"] })
);
