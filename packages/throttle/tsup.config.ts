import { defineConfig } from "tsup";
import { tsupConfig } from "../../tsup.base";

// Multi-entry build (AD-1/AR8): the transport-blind core (`.`) plus the transport presets and the
// store contract kit, each a subpath export (`./http`, `./electron-ipc`, `./testing`).
export default defineConfig(
  tsupConfig({
    entry: [
      "src/index.ts",
      "src/http.ts",
      "src/electron-ipc.ts",
      "src/testing.ts",
    ],
  })
);
