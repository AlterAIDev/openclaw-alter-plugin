# Contributing

Thanks for your interest in `@alter-ai/openclaw-plugin`.

## How this repository is maintained

Releases are prepared from Alter's internal source tree and arrive here as
`release: vX.Y.Z` pull requests. Community pull requests are welcome and are
reviewed and merged here as usual; maintainers carry every merged change into
the internal tree, so the next release keeps it.

Merging a `release:` pull request tags the version and publishes the GitHub
release (see `.github/workflows/release.yml`).

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
- `tests/` — vitest unit tests for the security-sensitive primitives.
- `deploy/` + `fly.toml` — a reference Fly.io deployment.
- `OPERATOR_SETUP.md` — end-to-end provisioning recipe.

## Pull requests

- Conventional-commit titles (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:`, `perf:`, `ci:`).
- `pnpm typecheck && pnpm test` must pass.
- Don't bump the version in `package.json` or edit `CHANGELOG.md`; releases
  do that.
- New tools: every user-supplied string param needs explicit `minLength` /
  `maxLength`; header-bound fields need a CRLF-rejecting `pattern`; URL path
  segments built from user input must use `encodeURIComponent`. Add a
  `toProxyArgs` test and a `Value.Check` validation test.

## Security

Please report vulnerabilities privately — see [SECURITY.md](./SECURITY.md).
Do not open a public issue for a security problem.
