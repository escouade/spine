import type { Options } from "tsup";

/**
 * Shared tsup build config for every publishable @spinejs package.
 *
 * Emits dual ESM (`.js`) + CJS (`.cjs`) bundles and `.d.ts` types into `dist/`.
 * Workspace deps (`@spinejs/*`) and third-party deps are kept external — they
 * resolve to the consumer's installed copy, not inlined into the bundle.
 */
export function tsupConfig(overrides: Options = {}): Options {
  const { external = [], ...rest } = overrides;
  return {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    // For the .d.ts pass, resolve workspace deps to their already-built
    // `dist/*.d.ts` (deps build first via nx `^build`) instead of the on-disk
    // `types: ./src/index.ts` dev shape. Following a dep into its source pulls
    // it outside this package's rootDir (TS6059) and trips rollup-plugin-dts.
    dts: {
      compilerOptions: {
        paths: { "@spinejs/*": ["packages/*/dist/index.d.ts"] },
      },
    },
    sourcemap: true,
    clean: true,
    treeshake: true,
    // Ship minified bundles (strips comments + mangles locals). `keepNames`
    // preserves class/function names — SpineJS resolves DI tokens by name and
    // reads `class.name`/decorator metadata, so mangling them would break
    // consumers. Sourcemaps stay emitted for debugging into the lib.
    minify: true,
    keepNames: true,
    // Keep every @spinejs/* dependency external — referenced by import, never
    // inlined — in both the JS bundle and the .d.ts.
    external: [
      /^@spinejs\//,
      ...(Array.isArray(external) ? external : [external]),
    ],
    ...rest,
  };
}
