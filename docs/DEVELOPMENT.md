# Development guide

Navigation map for contributors. Read this before opening files.

## High-level architecture

```
chat channel (Slack, etc.)
        │
        ▼
OpenClaw gateway ───► alter plugin (definePluginEntry)
                         │
                         ├── IdentityStore         channel-user → app_user_id + sealed JWT
                         ├── AuthSessionStore      in-flight sign-in sessions (sealed)
                         ├── AuthPoller            background App.pollAuthSession loop, resumable
                         ├── GrantsStore           (app_user_id, provider) → grant_id cache
                         ├── PendingConnectsStore  one-time CSRF nonces for connect flow
                         ├── StateHmac             HMAC-signed state tokens (typ-discriminated)
                         ├── PendingApprovalLock   per-session HITL gate
                         ├── RateLimitStore        per-user daily LLM token cap
                         ├── /alter/connect/cb     OAuth redirect handler (HTTP route)
                         ├── /alter slash command  login/connect/connections/wallet/status
                         ├── operator CLI          login/db-rotate-key/enable-tools/unlink/...
                         └── 29 tool specs         (provider, verb) → proxyRequest args
                              │
                              ▼
                         Agent.proxyRequest → Alter Vault → upstream provider API
```

Composition root: `src/index.ts`. Every store/handler is constructed there and
passed into the four registrars (`registerConnectRoutes`, `registerCommands`,
`registerCli`, `registerRateLimitHook` + per-tool `registerAlterTool`).

## File map

| Path | Role |
|---|---|
| `src/index.ts` | Plugin entry. Wires every store + handler. Read first to understand boot order. |
| `src/config.ts` | Plugin config loader. Validates `publicBaseUrl`, `channelHashSalt`, HTTPS scheme. |
| `src/secrets.ts` | Env-var-loaded secrets (agent/app API keys, HMAC secrets, master DB key). Fails fast at boot on missing/short values. |
| `src/alter-client.ts` | Constructs Agent + App SDK clients. Owns `currentUserJwt` AsyncLocalStorage scope and the fail-closed `userTokenGetter`. |
| `src/sqlite.ts` | SQLite (`node:sqlite`) connection cache + schema migrations. Bump `SCHEMA_VERSION` and add migration logic when changing tables. |
| `src/commands.ts` | `/alter` slash-command router: login, connect, connections, wallet, status. |
| `src/cli/index.ts` | Operator CLI subcommands. |
| `src/http-utils.ts` | `sendHtml`, `escapeHtml`, `errorPage`/`successPage`. PageBody requires explicit `text` (auto-escaped) or `html` (trusted). |
| `src/tool-result-cap.ts` | UTF-8-byte-aware JSON truncation with envelope-cap fallback (8 KB default). |
| `src/pending-approval-lock.ts` | Per-session approval lock with TTL auto-purge. |
| `src/crypto/derive-keys.ts` | HKDF subkey derivation from the master DB key. `KEY_LABELS` is the registry — never rename labels. |
| `src/crypto/jwt-at-rest.ts` | AES-256-GCM seal/open with `(channel_kind, channel_user_id, row_id)` AAD binding. |
| `src/identity/store.ts` | `identity_link` table. `upsert` serializes concurrent first-sign-ins; returns `inserted / refreshed / rejected_collision`. |
| `src/identity/auth-session.ts` | `AuthSessionStore` (sealed pending rows keyed by HMAC of session_token) + `AuthPoller` (resumable background loop). |
| `src/identity/jwt-decode.ts` | Unverified JWT payload decode — safe ONLY because Alter pre-verifies server-side. |
| `src/identity/sub-hash.ts` | Salt-mixed SHA-256 prefix of IdP sub for log correlation. |
| `src/identity/login-rate-limit.ts` | Per-(channel, user) token bucket on `App.createAuthSession`. |
| `src/grants/state-hmac.ts` | HMAC-SHA256 signed state payloads with mandatory `typ` discriminator (`CONNECT` / `LINK`). |
| `src/grants/connect-routes.ts` | `/alter/connect/cb` handler: rate limit → HMAC verify → nonce consume → identity match → paginated `listGrants` → cache upsert. |
| `src/grants/pending-connects.ts` | One-time CSRF nonces; `consume` is atomic via `UPDATE … WHERE consumed=0`. |
| `src/grants/store.ts` | `grants` table — `(app_user_id, provider)` → `grant_id`. |
| `src/rate-limit/` | Per-(app_user, UTC-day) token counters + the `llm_output` hook. |
| `src/tools/base.ts` | `registerAlterTool` — the central wrapper. Order: channel check → approval lock → identity gate → quota gate → grant lookup → TypeBox validation → `proxyRequest` → error classification. |
| `src/tools/registry.ts` | `TOOL_SPECS` — single source of truth for the tool list. |
| `src/tools/providers.ts` | `PROVIDERS` — canonical id + display name + `oauth` flag; `matchProviderId` handles aliases. |
| `src/tools/<provider>-<verb>.ts` | One file per tool: TypeBox `parameters`, `provider`, `hitl?`, `toProxyArgs`, `formatResult`. |
| `src/skills/` | LLM-facing skill markdown. `alter-accounts/SKILL.md` is the auth-model overview. |

## Key invariants

- **AsyncLocalStorage user-JWT scope.** Any SDK method requiring user identity
  must run inside `currentUserJwt.run(jwt, async () => …)`. The fail-closed
  `userTokenGetter` throws if no JWT is in scope.
- **AEAD AAD binding.** Every seal includes `(channel_kind, channel_user_id,
  row_id)` in AAD; row-swap attacks fail GCM verify.
- **HKDF subkey labels are stable.** Never rename a `KEY_LABELS.*` value —
  rotation would invalidate every existing ciphertext sealed under the old
  subkey.
- **State HMAC `typ` discriminator.** `verify` requires `expectedTyp` and
  rejects mismatches before any field access on the parsed payload.
- **One identity, one channel-user.** Two IdP `sub`s for the same channel-user
  → `rejected_collision`; the operator migrates with
  `openclaw alter unlink-channel-user`.
- **Single-use nonces.** `pending_connects.consume` refuses replays atomically.
- **HITL invariant post-check.** Tools marked `hitl: true` MUST return
  `PendingApproval` from `proxyRequest`. If they return `ApprovalResult`, the
  server-side policy is missing `requires_approval` — the plugin logs ERROR
  (`HITL VIOLATION`) and drops the grant cache.
- **Process-local stores.** Rate-limit buckets, the `listGrants` singleflight,
  and `AuthPoller.active` are per-process; gateway HA would need a shared
  store.
- **AAD `row_id` uses `created_at_ms`.** Never change the row_id derivation
  without a migration that re-seals every row.

## How to add a new tool

1. Create `src/tools/<provider>-<verb>.ts` exporting `AlterToolSpec<TParams>`.
2. Pick `provider` from `PROVIDERS` in `src/tools/providers.ts`; add it there
   first if missing (canonical lowercase-alnum id + display name + `oauth`).
3. Set `hitl: true` iff the tool writes / has user-visible side effects.
4. Define `parameters` as TypeBox `Type.Object({...})`. Every user-supplied
   string needs explicit `minLength` + `maxLength`; header-bound fields need a
   CRLF-rejecting `pattern` (e.g. `^[^\r\n]+$`).
5. `toProxyArgs(params)` returns `{method, url, jsonBody?, headers?,
   queryParams?}`. URL path segments holding user input must use
   `encodeURIComponent`.
6. `formatResult(result)` — default is `result.bodyJson()` with a
   `{ raw: bodyText() }` fallback; override only to reshape.
7. Append to `TOOL_SPECS` in `src/tools/registry.ts`.
8. Append the tool name to `openclaw.plugin.json` `contracts.tools`.
9. (Optional) Create `src/skills/alter-<provider>/SKILL.md`.
10. Add a `toProxyArgs` test and a `Value.Check` validation test; run
    `pnpm typecheck && pnpm test && pnpm build`.

## Run it locally

```sh
pnpm install
pnpm dev                   # http://127.0.0.1:18789, ready in a few seconds
```

`pnpm dev` (`dev/gateway.mjs`) builds the plugin and starts a real OpenClaw
gateway, the version this repo pins, with the plugin linked from your checkout.
Its state lives in `.dev/`; your `~/.openclaw` is never touched. To pick up a
code change, stop it with Ctrl-C and run `pnpm dev` again. `pnpm dev -- --fresh`
forgets every earlier sign-in and connection.

With nothing configured, the plugin talks to `dev/fake-alter.mjs`, a local
stand-in for the Alter API: its sign-in, connect and approval links open small
pages on http://127.0.0.1:8787 where you pick a user name, allow a provider, or
approve an action. Nothing reaches a real provider; reads return canned data.

To chat with the agent, copy `.env.dev.example` to `.env.dev` and fill in:

- `OPENAI_API_KEY`, the model the agent uses;
- Slack (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`) or Discord (`DISCORD_BOT_TOKEN`)
  bot tokens; [deploy/fly/README.md](../deploy/fly/README.md) shows how to
  create the apps;
- optionally `OPENCLAW_ALTER_AGENT_API_KEY` + `OPENCLAW_ALTER_APP_API_KEY` to
  use a real Alter app instead of the fake (allow
  `http://127.0.0.1:18789/alter/connect/cb` as its Connect return URL).

The Control UI link `pnpm dev` prints is the operator's console. Alter tools
refuse there by design, because there is no chat user to act for: per-user
flows need Slack, Discord, or the end-to-end tests below.

## How to test

| Command | What it covers | Time |
|---|---|---|
| `pnpm test` | Unit tests, plus the end-to-end tests in `tests/e2e/` | ~1 s |
| `pnpm test:e2e` | Only the end-to-end tests | <1 s |
| `pnpm test:watch` | Interactive watch | |
| `pnpm typecheck` | `tsc` on `src/`, then on `src/` + `tests/` | |
| `pnpm dev --smoke` | Boots a real gateway with the plugin and the fake Alter in a throwaway state dir (it ignores `.env.dev` and leaves `.dev/` alone); checks registration, that every manifest tool is visible to the agent, that tools refuse callers who aren't chat users, and the connect callback; then stops | ~10 s |
| `bash deploy/fly/smoke-test.sh` | Builds the Fly image and boots it for each chat setup (Docker, network) | minutes |

CI runs all of these except the Docker smoke test on every pull request; the
Docker one runs when the deployment or dependencies change.

**End-to-end tests** (`tests/e2e/`) run the real plugin and the real Alter SDK
against `dev/fake-alter.mjs` over HTTP, with no accounts. `plugin-host.ts`
loads the plugin entry the way the gateway does and lets a test act as a chat
user: `host.command(alice, "connect github")`, `host.callTool(alice, name,
params)`, and HTTP to the connect callback. The fake plays the other side:
`alter.signIn(link, "alice")`, `alter.connect(link)`, `alter.decide(link,
"approved")`, `alter.revokeInWallet("alice", "github")`,
`alter.revokeUserTokens("alice")`, and `alter.calls` records every request the
plugin proxied.

The fake follows Alter where the plugin depends on it. An agent key
(`alter_ak_…`) and an app key (`alter_rk_…`) see different grants: connecting
creates the user's grant, which the app key lists and revokes, and the
agent's delegation on it, a separate id, which the agent key lists and
proxies through (the user's grant id is a 404 for the agent). Reconnecting a
provider the user already has reuses both. Like Alter, it doesn't check that
a proxied grant belongs to the user token sent with it; it records the
token's user (`sub`) and the grant's (`owner`) on every call, and the
multi-user tests assert they match.

The tests cover sign-in, connecting and reconnecting a provider, reads,
approval-gated writes (approved, still running, failed, denied), revoking in
chat and in the wallet, Alter rejecting a token, the daily usage cap, several
people in DMs and in one shared channel, the same person on two chat
platforms, and a restart, including a sign-in still open across it. Add a
test there for any change to a user-visible flow. Each assertion should be
one the plugin can fail: check what it sent to Alter (`alter.calls`,
`alter.requests`) or told the user, not what the fake did on its own.

Each test that touches SQLite uses `mkdtempSync` for an isolated workspace dir
and calls `closeDatabase()` in `afterEach`.

The reference deployment has two layers of tests:

- `tests/deploy-config-reconcile.test.ts` (part of `pnpm test`) covers
  `deploy/fly/config-reconcile.cjs`, the boot-time logic that syncs the tool
  allowlist and turns Slack/Discord on from their secrets.
- `bash deploy/fly/smoke-test.sh` builds the Fly image and boots it in Docker
  for each chat setup (none, Slack, Discord, restart with both) with
  placeholder secrets. Run it before changing the Dockerfile, the entrypoint,
  the template or dependencies; CI runs it on pull requests that touch them.

## Operator runbooks

| Task | Command |
|---|---|
| Sign in as operator from terminal | `openclaw alter login --workspace-dir <gw-dir>` |
| Rotate AES-256-GCM master DB key | Set new key in env, then `openclaw alter db-rotate-key --new-key-env <NEW>_ENV --workspace-dir <gw-dir>` |
| Rotate connect-state HMAC secret | `openclaw alter rotate-state-hmac` (prints runbook) |
| Add every plugin tool to the agent's `alsoAllow` | `openclaw alter enable-tools` |
| Remove a channel-user link | `openclaw alter unlink-channel-user --kind <ch> --user-id <id> --yes` |

## Gotchas

- **`alter-client.ts` mutates `process.env.ALTER_BASE_URL`.** The Alter SDK
  pins baseUrl at constructor time from this env var; the plugin sets it only
  if unset.
- **Skills aren't auto-deployed.** `src/skills/` is the source; OpenClaw reads
  skills from the agent workspace's `skills/` directory. The Fly entrypoint
  handles this in the reference deployment.
- **`tools.alsoAllow` gates LLM visibility.** A registered tool not in
  `tools.alsoAllow` is invisible to the agent — run
  `openclaw alter enable-tools` after adding tools.
- **HITL invariant is a post-check, not a pre-check.** By the time the
  post-check fires, the action has already executed. The authoritative gate is
  the server-side Alter policy; alert on the `HITL VIOLATION` log line.
- **`pnpm.overrides` in `package.json` only patch the dev install.** They pin
  fixed versions of packages that arrive through the dev copy of `openclaw`
  (Express, the MCP SDK, undici, tar, …), because pnpm doesn't honor openclaw's
  npm-shrinkwrap. The published plugin never ships them: `pnpm audit --prod`
  is clean without the overrides. Drop an entry once openclaw's own
  dependency range includes the fix.
