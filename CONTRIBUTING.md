# Contributing to SpineJS

Thanks for taking the time to contribute.

## Setup

```bash
yarn install
```

## Before opening a PR

Run the full check suite and make sure it's clean:

```bash
yarn lint:all
yarn typecheck:all
yarn test:all
```

If formatting is off, fix it with:

```bash
yarn format:write
```

## Git flow

`main` has a linear history: GitHub merges PRs via squash/rebase, which rewrites commit SHAs. If you reuse a branch after its PR has merged, that branch still has its old commits — now duplicated on `main` under different SHAs — so a new PR from it starts out in conflict. To avoid this:

- **One new branch per PR, with a unique name each time** (e.g. `docs/xxx-2026-06-30`). Never reuse a branch that's already been merged.
- **After a merge, delete the branch and start fresh from an up-to-date `main`**:
  ```bash
  git checkout main && git fetch origin && git reset --hard origin/main
  ```
  Create your next branch from there.
- **Never commit or push directly to `main`.** Never replay a branch's commits by hand (cherry-pick, redoing the same work) — integrate changes only by merging the PR: `gh pr merge <n> --squash`.
- **Before opening or updating a PR, rebase on an up-to-date `main`**:
  ```bash
  git fetch origin && git rebase origin/main
  git push --force-with-lease
  ```

## Documentation

Any change to the framework's public interface (API, decorators, exported types, options) or any new feature must be reflected in the Docusaurus docs, in **both** English and French:

- `apps/docs-site/docs/**/*.md` (EN)
- `apps/docs-site/i18n/fr/docusaurus-plugin-content-docs/current/**/*.md` (FR)
- `apps/docs-site/src/pages/index.tsx` and `apps/docs-site/i18n/fr/code.json` if the change affects the homepage
