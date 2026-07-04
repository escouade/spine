# Releasing

The `@spinejs/*` packages are published to the public npm registry as a single
**fixed** release group — every package moves to the same version together.

Auth uses npm **trusted publishing (OIDC)**: the CI release runs **tokenless**.
There is one exception — the very first publish of a brand-new package name must
use a token, because npm only lets you attach a Trusted Publisher to a package
that already exists. So there are two setup phases: a one-time bootstrap per
package, then tokenless releases forever after.

## Phase 1 — Bootstrap each new package (one-time, token, local)

Done once per package name (all 8 for the first `0.1.0`). Not run in CI.

```bash
# 1. build the packages
yarn nx run-many -t build --projects=tag:publishable

# 2. create a short-lived token on npmjs.com that BYPASSES 2FA:
#    classic "Automation" token, or granular (scope: @spinejs, read+write)
#    with "Bypass two-factor authentication" checked. A plain token triggers
#    an EOTP/WebAuthn prompt and yarn crashes in non-interactive shells.
export YARN_NPM_AUTH_TOKEN=npm_xxx

# 3. publish every package once (yarn converts workspace:* + applies publishConfig)
yarn workspaces foreach --all --no-private --topological \
  npm publish --tolerate-republish --access public

# 4. delete the token on npmjs.com immediately after.
```

## Phase 2 — Configure Trusted Publishers (one-time, npmjs.com UI)

For **each** of the 8 packages: _npmjs.com → the package → Settings → Trusted
Publisher → GitHub Actions_, then:

| Field        | Value           |
| ------------ | --------------- |
| Organization | `escouade`      |
| Repository   | `spine`         |
| Workflow     | `release.yml`   |
| Environment  | _(leave empty)_ |

## Phase 3 — Cutting a release (tokenless, CI)

From then on, run the **Release** workflow (_Actions → Release → Run workflow_):

| Input           | Value                                                                     |
| --------------- | ------------------------------------------------------------------------- |
| `specifier`     | `0.2.0` (explicit) or a bump keyword `patch`/`minor`                      |
| `first_release` | **true** only for the very first tagged release                           |
| `dry_run`       | `true` to preview version + changelog without publishing                  |
| `publish_only`  | **recovery** — skip version/tag, rebuild + publish HEAD as-is (see below) |

The workflow:

1. builds every publishable package (`dist/`),
2. `nx release --skip-publish` → bumps versions, writes `CHANGELOG.md`, commits,
   tags `vX.Y.Z`, pushes,
3. per package: `yarn pack` (rewrites `workspace:*` → the concrete version and
   applies `publishConfig` → dist entry points **into the tarball**) then
   `npm publish <tarball>` — authenticated by the GitHub **OIDC** token
   (`id-token: write`), no npm secret. Provenance is attached automatically.

> Why the two tools: only **yarn** produces a correct tarball (npm ignores the
> `workspace:` protocol and `publishConfig` overrides), but only the **npm CLI**
> (≥ 11.5.1) speaks npm's OIDC handshake — yarn Berry's OIDC path is
> undocumented and broken. So yarn builds the tarball, npm uploads it.

### Recovery: publish failed after the tag was pushed

If the publish step fails **after** `nx release` already pushed the version
commit + tag (npm outage, OIDC hiccup), re-running the workflow normally would
abort on the existing tag. Instead, re-run it with `publish_only: true`: the
version/tag step is skipped and the packages are rebuilt and published from the
already-bumped `main` HEAD. Packages already on npm are detected (`npm view`)
and skipped, so only the missing ones are published.

## Prerequisites

- **Branch protection** — the release job pushes the version commit and tag to
  `main`. If `main` is protected, allow `github-actions[bot]` to bypass the push
  restriction (or run the workflow from an unprotected release branch).
- No npm secret in the repo (OIDC replaces it).

## Local dry-run

```bash
# preview the version bump + changelog, no writes
yarn nx release <specifier> --skip-publish --dry-run --first-release

# inspect exactly what a package would publish (converted deps + file list)
cd packages/core && yarn pack --out /tmp/core.tgz && tar -tzf /tmp/core.tgz
```

## Notes

- **Post-publish 404s are replication lag, not failure.** npmjs read replication
  can trail the publish by several minutes: `npm view` / GET returns 404 while a
  re-publish attempt gets `403 cannot publish over the previously published
versions` — that 403 is the proof the publish landed. Wait it out; don't
  re-publish through another path.
- Build output: dual ESM (`dist/index.js`) + CJS (`dist/index.cjs`) + types
  (`dist/index.d.ts` / `.d.cts`), produced by `tsup` (`tsup.base.ts`).
- `examples/*` and `apps/docs-site` are `private` and never published.
- A package is included in the release by carrying the `publishable` nx tag
  (`packages/*/project.json`) — no need to edit the workflow when adding one.
- A **new** package added later needs its own Phase 1 + Phase 2 bootstrap before
  it can ride the tokenless release.
