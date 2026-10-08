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

## How to test

```sh
pnpm test                  # vitest run
pnpm test:watch            # interactive watch
pnpm typecheck             # tsc --noEmit
```

Each test that touches SQLite uses `mkdtempSync` for an isolated workspace dir
and calls `closeDatabase()` in `afterEach`.

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
