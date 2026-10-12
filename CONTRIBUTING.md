# Contributing

Thanks for your interest in `@alter-ai/openclaw-plugin`.

## How this repository is maintained

Releases are prepared from Alter's internal source tree and arrive here as
`release: vX.Y.Z` pull requests. Community pull requests are welcome; once
merged here, maintainers carry each change into the internal tree, so the
next release keeps it.

Merging a `release:` pull request tags the version and publishes the GitHub
release (see `.github/workflows/release.yml`).

## Contribution policy

- **Anyone can propose a change** by opening a pull request from a fork. Only
  the maintainers (`@AlterAIDev/openclaw-maintainers`, see
  `.github/CODEOWNERS`) can merge.
- **Every pull request needs a maintainer's approval.** The approval must come
  from someone other than the person who pushed last, and new commits after an
  approval dismiss it. Release pull requests follow the same rule.
- **CI must pass:** typecheck, tests, build, the gitleaks secret scan, and the
  DCO sign-off check. For contributors outside the project, CI runs once a
  maintainer approves the run.
- **Sign off every commit (DCO).** Add a `Signed-off-by:` line with
  `git commit -s`. It certifies that you wrote the change or otherwise have
  the right to submit it under this project's MIT license, as described in
  the [Developer Certificate of Origin](https://developercertificate.org).
  The line must use the same email as the commit author. To fix a branch:
  `git rebase --signoff main`, then force-push.
- **Security issues** go through private reporting, never a public issue or
  pull request (see [SECURITY.md](./SECURITY.md)).

## Getting started

```sh
pnpm install
pnpm build       # tsc -> dist/
pnpm typecheck
pnpm test        # vitest — covers the security primitives
```

Requires **Node ≥ 22** (the plugin uses the built-in `node:sqlite`).

## What lives where

- `src/` — plugin source. `src/index.ts` is the composition root; read it
  first. Stores live in `src/identity/`, `src/grants/`, `src/rate-limit/`;
  crypto in `src/crypto/`; the central tool wrapper in `src/tools/base.ts`;
  the tool registry in `src/tools/registry.ts`.
- `docs/DEVELOPMENT.md` — the full navigation map: architecture, file map,
  key invariants, how to add a tool/provider, gotchas. Read it before your
  first change.
- `docs/MULTI_USER_LIMITS.md` — what the plugin isolates per user and what it
  cannot. Read it before deploying into a shared channel.
- `docs/USER_GUIDE.md` — the end-user guide. Keep it in step with any change
  to commands, approvals or what users see.
- `tests/` — vitest unit tests for the security-sensitive primitives.
- `deploy/` + `fly.toml` — a reference Fly.io deployment.
- `OPERATOR_SETUP.md` — end-to-end provisioning recipe.

## Pull requests

- Conventional-commit messages (`feat:`, `fix:`, `docs:`, `refactor:`,
  `test:`, `chore:`, `perf:`, `ci:`). Pull requests are merged with
  **Rebase and merge**, so each of your commits lands on `main` as written:
  squash fixups into meaningful commits before review.
- `pnpm typecheck && pnpm test` must pass, and every commit is signed off
  (`git commit -s`).
- Don't bump the version in `package.json` or edit `CHANGELOG.md`; releases
  do that.
- New tools: every user-supplied string param needs explicit `minLength` /
  `maxLength`; header-bound fields need a CRLF-rejecting `pattern`; URL path
  segments built from user input must use `encodeURIComponent`. Add a
  `toProxyArgs` test and a `Value.Check` validation test.

## Security

Please report vulnerabilities privately — see [SECURITY.md](./SECURITY.md).
Do not open a public issue for a security problem.
