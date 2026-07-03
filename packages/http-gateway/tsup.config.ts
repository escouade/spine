import { defineConfig } from "tsup";
import { tsupConfig } from "../../tsup.base";

export default defineConfig(
  tsupConfig({ entry: ["src/index.ts", "src/testing.ts"] })
);
