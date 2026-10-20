# Security Policy

`@alter-ai/openclaw-plugin` sits on the identity/authorization path of a
multi-user agent: it stores per-user IdP tokens, brokers OAuth grants, and
gates tool calls. We take reports seriously and appreciate responsible
disclosure.

## Supported versions

This is a `0.x` project. Only the latest published version receives security
fixes. Pin a version and watch releases.

| Version | Supported |
|---|---|
| latest `0.x` | ✅ |
| older `0.x`  | ❌ |

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.**

Report privately via GitHub's **“Report a vulnerability”** button under this
repository's **Security → Advisories** tab (GitHub Private Vulnerability
Reporting). If you cannot use that, email **security@alterauth.com** with:

- a description of the issue and its impact,
- the affected file(s) / version,
- reproduction steps or a proof of concept,
- any suggested remediation.

We aim to acknowledge within **3 business days** and to ship a fix or mitigation
for confirmed high-severity issues within **30 days**. We're happy to credit
reporters in the release notes unless you prefer to stay anonymous.

## Scope

**In scope** — anything in this repository:

- The identity gate (`src/identity/`, `src/alter-client.ts`) and at-rest
  encryption (`src/crypto/`).
- The Connect/OAuth callback flow (`src/grants/`, especially HMAC state and the
  callback handler).
- The tool wrapper and input validation (`src/tools/base.ts`, per-tool specs).
- Rate limiting, the approval lock, SQLite schema/migrations.
- The deploy artifacts under `deploy/` and `fly.toml`.

**Out of scope** (report to the respective project/vendor):

- The Alter Vault backend and the `@alter-ai/alter-sdk` package.
- The OpenClaw gateway itself.
- Upstream provider APIs (Google, Slack, GitHub, …) and the IdP (e.g. Clerk).
- Findings that require an already-compromised gateway host or operator
  credentials.

## Security model (summary)

Each mitigation below is implemented and unit-tested in `tests/`:

- **Secrets are environment-only** — agent/app API keys, the HMAC secret, and
  the AES-256-GCM master DB key are read from `process.env` by name and are
  never accepted in plugin config (which would surface them in
  `openclaw plugins config` output). See `src/secrets.ts`.
- **At-rest encryption** of identity JWTs is AES-256-GCM with
  `(channel_kind, channel_user_id, row_id)` bound into the AAD; HKDF derives
  per-context subkeys from the master key.
- **A fail-closed chokepoint** (`currentUserJwt` AsyncLocalStorage + an `App`
  Proxy) makes user-scoped SDK calls throw rather than run without a user JWT.
- **Connect state is HMAC-signed**, single-use-nonce-bound, and the callback
  verifies the new grant actually belongs to the bound `app_user` before
  caching it.
- **Identity-collision rejection.** Re-linking with the same IdP `sub` updates
  the stored JWT; re-linking a `(channel_kind, channel_user_id)` with a
  *different* `sub` is rejected rather than silently re-pointing grants
  (`tests/identity-store.test.ts`).
- **Alter-verified sign-in.** The user's token comes from
  `App.pollAuthSession` and is verified by Alter server-side (signature,
  issuer, audience, expiry, key rotation). The plugin only decodes `sub` and
  `exp` locally, and re-prompts sign-in once `exp` passes or Alter rejects it.
- **Per-user approval lock**, keyed `(session_id, app_user_id)` and consulted
  only after identity resolves, so in a group DM one participant never sees
  another's wallet link (`tests/approval-lock-cross-user.test.ts`).
- **Byte-aware tool-result truncation.** `capToolResultJson` measures UTF-8
  bytes, caps lists, and always emits parseable JSON with a
  `{truncated, truncatedReason, partial}` envelope.
- **All LLM→tool input is validated at runtime** (TypeBox), with explicit
  length bounds, CRLF-injection patterns on header-bound fields, and
  `encodeURIComponent` on URL path segments.

## Known limitations (please don't report these as new findings)

These are documented, intentional trade-offs for the current version:

- **HITL is a _post_-check, not a pre-check.** The SDK doesn't expose
  `requires_approval` on a grant, so a write on a mis-policied grant can execute
  before the plugin logs the violation. The authoritative gate is the
  server-side Alter policy; operators must set `requires_approval` on every
  write-capable grant and alert on the `HITL VIOLATION` ERROR log.
- **Process-local state** — single-gateway-process assumption.
- **No silent IdP token refresh** — expired JWTs re-prompt sign-in.
- **Per-day (not per-minute) rate limiting**, incremented post-call.
- **Some backend error text reaches the agent.** Policy-violation and
  invalid-request messages from Alter, and an approved action's execution
  error, are relayed to the LLM so it can answer the user accurately; this
  assumes those messages are user-safe. Other 4xx/5xx detail goes only to the
  gateway log.

## Notes for operators

- The Fly entrypoint installs this plugin with
  `--dangerously-force-unsafe-install`. That flag exists **only** because the
  first-party operator CLI (`src/cli/index.ts`) uses `child_process`, which
  OpenClaw's install scanner flags. It is safe here because this is
  first-party, from-source code you can audit — **do not** copy that flag for
  third-party plugins.
- Serve `publicBaseUrl` over HTTPS only (the config loader enforces `https://`).
- Set a unique, random `channelHashSalt` per deployment.
- Rotate `OPENCLAW_ALTER_DB_KEY` and `OPENCLAW_ALTER_STATE_HMAC_SECRET`
  periodically (see [OPERATOR_SETUP.md](./OPERATOR_SETUP.md) → Maintenance).
- Back up `<workspaceDir>/.alter/plugin.sqlite`; it holds encrypted JWTs and the
  grant cache.
