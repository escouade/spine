// prepack guard: only yarn produces a correct tarball for these packages.
// npm pack/publish would ship src entry points (publishConfig not applied)
// and unconverted workspace:^ dependencies — a broken package.
const ua = process.env.npm_config_user_agent || "";
if (!ua.includes("yarn/")) {
  console.error(
    "Pack/publish must go through yarn (`yarn pack` / `yarn npm publish`).\n" +
      "npm does not apply publishConfig overrides nor convert workspace:^ deps;\n" +
      "the resulting tarball would have broken entry points. See RELEASING.md."
  );
  process.exit(1);
}
