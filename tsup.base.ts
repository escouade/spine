import type { Options } from "tsup";

/**
 * Shared tsup build config for every publishable @spinejs package.
 *
 * Emits dual ESM (`.js`) + CJS (`.cjs`) bundles and `.d.ts` types into `dist/`.
 * Workspace deps (`@spinejs/*`) and third-party deps are kept external — they
 * resolve to the consumer's installed copy, not inlined into the bundle.
 */
export function tsupConfig(overrides: Options = {}): Options {
  return {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    // Neutralize tsconfig `paths` for the .d.ts build: workspace deps
    // (`@spinejs/*`) must resolve to their built types in node_modules and be
    // kept as external imports, not pulled in from source (which sits outside
    // this package's rootDir and would trip TS6059).
    dts: { compilerOptions: { paths: {} } },
    sourcemap: true,
    clean: true,
    treeshake: true,
    ...overrides,
  };
}
