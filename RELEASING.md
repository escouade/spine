# Releasing

The `@spinejs/*` packages are published to the public npm registry as a single
**fixed** release group — every package moves to the same version together.

## One-time setup

1. **npm token** — create an **Automation** token for the `@spinejs` org on
   npmjs.com, then add it as a GitHub repo secret named `NPM_TOKEN`
   (_Settings → Secrets and variables → Actions_).
2. **Branch protection** — the release job pushes the version commit and tag to
   `main`. If `main` is protected, allow the `github-actions[bot]` to bypass the
   push restriction (or run the workflow from an unprotected release branch).

## Cutting a release

Run the **Release** workflow from the GitHub Actions tab
(_Actions → Release → Run workflow_):

| Input           | Value                                                    |
| --------------- | -------------------------------------------------------- |
| `specifier`     | `0.1.0` (explicit) or a bump keyword `patch`/`minor`     |
| `first_release` | **true** for the very first release (no prior git tag)   |
| `dry_run`       | `true` to preview version + changelog without publishing |

The workflow then:

1. builds every publishable package (`dist/`),
2. runs `nx release --skip-publish` → bumps versions, writes `CHANGELOG.md`,
   commits, tags `vX.Y.Z`, pushes,
3. `yarn workspaces foreach … npm publish` → publishes each package. **Yarn** (not
   npm) does the publish because it rewrites the internal `workspace:*` ranges to
   the concrete version in the tarball; `npm publish` would ship `workspace:*`
   verbatim and break installs.

## Local dry-run

```bash
# preview the version bump + changelog, no writes
yarn nx release <specifier> --skip-publish --dry-run --first-release

# inspect exactly what a package would publish (converted deps + file list)
cd packages/core && yarn pack -o /tmp/core.tgz && tar -tzf /tmp/core.tgz
```

## Notes

- Build output: dual ESM (`dist/index.js`) + CJS (`dist/index.cjs`) + types
  (`dist/index.d.ts` / `.d.cts`), produced by `tsup` (`tsup.base.ts`).
- `examples/*` and `apps/docs-site` are `private` and never published.
- A package is included in the release by carrying the `publishable` nx tag
  (`packages/*/project.json`) — no need to edit the workflow when adding one.
