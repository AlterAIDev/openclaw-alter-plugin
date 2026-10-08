# @alter-ai/openclaw-plugin

Multi-user identity, OAuth grants, HITL approvals, and per-user audit for [OpenClaw](https://github.com/openclaw/openclaw) deployments — backed by [Alter Vault](https://alterauth.com).

Turn one OpenClaw deployment into a **team-hosted, multi-user agent**: each team
member signs in once via your IdP, links their channel identity (Slack /
WebChat / Telegram / etc.) to an Alter `app_user`, connects their own provider
accounts via Alter Connect, and the OpenClaw agent acts on their behalf with
HITL gating and per-user audit. Each user opens Alter Wallet to see *their*
audit log, grants, and pending approvals — not anyone else's.

> **Status:** 0.x — early. The security primitives (AAD-bound at-rest
> encryption, App SDK chokepoint, HMAC-signed Connect state with grant-id
> ownership check, identity-collision rejection, per-user approval lock) are
> built and tested; sign-in is Alter-hosted, through any identity provider
> Alter supports.

## Install

```sh
# in your OpenClaw deployment dir
openclaw plugins install @alter-ai/openclaw-plugin
# or local checkout:
openclaw plugins install ./openclaw-alter-plugin
```

Requires Node ≥ 22 (uses the `node:sqlite` built-in). On boot, you'll see
`ExperimentalWarning: SQLite is an experimental feature` — that's Node telling
you `node:sqlite` is still flagged experimental in 22-24. It works, and the
warning will go away when Node graduates the API.

See **[OPERATOR_SETUP.md](./OPERATOR_SETUP.md)** for the full provisioning
recipe (Alter app and API keys, identity provider, provider integrations,
env vars, plugin config). Reading that doc end-to-end is the only way to actually run
this plugin.

## What it gives users

After install, every user in your channel gets:

- `/alter login` — link their channel identity to an Alter account.
- `/alter connect <provider>` — connect a provider (e.g. Google) for OAuth.
- `/alter connections [revoke <id>]` — list / revoke their grants.
- `/alter wallet` — open the Alter Wallet (per-user audit log + grants).
- `/alter status [clear]` — show link state + approval lock; clear if stale.

And these 29 tools, addressable by the LLM in any chat turn (HITL = the write
is gated behind human-in-the-loop approval in the Alter Wallet):

| Tool | Provider | HITL |
|---|---|---|
| `alter_gmail_search` | google | no |
| `alter_gmail_get_message` | google | no |
| `alter_gmail_send` | google | yes |
| `alter_gcal_list_events` | google | no |
| `alter_gcal_create_event` | google | yes |
| `alter_drive_search` | google | no |
| `alter_drive_get_file` | google | no |
| `alter_notion_search` | notion | no |
| `alter_notion_create_page` | notion | yes |
| `alter_slack_search` | slack | no |
| `alter_slack_post_message` | slack | yes |
| `alter_github_search_issues` | github | no |
| `alter_github_create_issue` | github | yes |
| `alter_github_create_comment` | github | yes |
| `alter_linear_search_issues` | linear | no |
| `alter_linear_create_issue` | linear | yes |
| `alter_calendly_get_current_user` | calendly | no |
| `alter_calendly_list_event_types` | calendly | no |
| `alter_calendly_list_scheduled_events` | calendly | no |
| `alter_calendly_list_event_invitees` | calendly | no |
| `alter_calendly_create_scheduling_link` | calendly | yes |
| `alter_calendly_cancel_event` | calendly | yes |
| `alter_linkedin_get_current_user` | linkedin | no |
| `alter_linkedin_list_posts` | linkedin | no |
| `alter_linkedin_share_post` | linkedin | yes |
| `alter_x_get_current_user` | twitter | no |
| `alter_x_post_tweet` | twitter | yes |
| `alter_x_list_user_tweets` | twitter | no |
| `alter_web_search` | tavily | no |

The canonical list lives in `src/tools/registry.ts` (and is mirrored in
`openclaw.plugin.json` `contracts.tools`). Adding a new tool is a 30-line file
using `registerAlterTool` — see `src/tools/web-search.ts` for the smallest
example. Anything Alter has a provider for can be exposed this way.

## Architecture in one paragraph

`src/index.ts` exports a `definePluginEntry({register})`. The `register`
callback installs the `/alter/connect/cb` HTTP route, slash commands, the
`llm_output` rate-limit hook, an operator CLI surface (`openclaw alter
login|enable-tools|db-rotate-key|rotate-state-hmac|unlink-channel-user`), and
one tool factory per tool. Each factory closes over
`ctx.{sessionId, messageChannel, requesterSenderId}` (trusted, runtime-provided
by OpenClaw) and returns an `AnyAgentTool`. The tool's `execute()` runs the
identity gate against `(messageChannel, requesterSenderId)` — looking up an
encrypted JWT in SQLite, checking the per-day rate-limit, finding the right
grant, then calling Alter via `agent.proxyRequest({grantId, …})`. Sign-in is
Alter-hosted: a user without a session gets a one-time link from
`App.createAuthSession`, and a background poller stores the token Alter returns.
HITL prompts set a `pendingApprovalLock`, keyed per session *and* user, that
blocks that user's further write calls until the approval resolves.

## Security guarantees

Each is implemented and unit-tested in `tests/`:

- **At-rest encryption with AAD binding.** Identity JWTs are stored
  AES-256-GCM encrypted with `(channel_kind, channel_user_id, row_id)` bound
  into the AAD. A SQLite-write attacker who swaps two ciphertext rows fails
  GCM authentication on the next read. (`tests/crypto.test.ts`.)
- **App SDK chokepoint.** The `App` instance is wrapped in a Proxy that
  refuses `listGrants` / `revokeGrant` / `revokeDelegation` whenever no user
  JWT is in `currentUserJwt` AsyncLocalStorage scope. A stray refactor that
  forgot `currentUserJwt.run(jwt, …)` throws loudly instead of silently
  cross-user-listing.
- **HMAC-signed Connect state with grant ownership check.** `/alter connect`
  signs an HMAC payload binding `(csrfNonce, sessionId, channelKind,
  channelUserId, appUserId, provider, iat, ttl)`. The callback verifies the
  HMAC, consumes a single-use csrfNonce row, AND verifies the
  newly-created grant actually belongs to the bound `appUserId` (it must
  appear in that user's own grant list for the provider, created since the
  state was minted) before persisting.
- **Identity-collision rejection.** Re-link with the same IdP `sub` updates
  the JWT (last-write-wins is fine within an identity); re-link with a
  *different* `sub` for the same `(channel_kind, channel_user_id)` is
  REJECTED rather than silently re-pointing grants. (`tests/identity-store.test.ts`.)
- **Alter-verified sign-in.** The user's token comes from
  `App.pollAuthSession` and is verified by Alter server-side (signature,
  issuer, audience, expiry, signing-key rotation). The plugin only decodes
  `sub` and `exp` locally, and re-prompts sign-in once `exp` passes or Alter
  rejects the token.
- **Per-user approval lock.** The pending-approval lock is keyed
  `(session_id, app_user_id)` and consulted only after identity resolves, so
  in a shared group DM one participant never sees another's wallet link.
  (`tests/approval-lock-cross-user.test.ts`.)
- **Byte-aware tool-result truncation.** `capToolResultJson` measures UTF-8
  bytes (not UTF-16 code units), caps lists, and always emits parseable JSON
  with a `{truncated, truncatedReason, partial}` envelope.

### Known security caveats

Read these before pointing the plugin at real users:

- **HITL is enforced as a _post_-check, not a pre-check.** The Alter SDK does
  not expose a grant's `requires_approval` policy on `OAuthGrantItem`, so the
  plugin cannot block a write *before* it executes. For an `hitl: true` tool it
  verifies *after* the call that `proxyRequest` returned a `PendingApproval`; if
  the server-side policy is missing `requires_approval`, the irreversible action
  has **already run** by the time the plugin logs the violation and drops the
  grant cache. **The real gate is the server-side Alter policy** — set
  `requires_approval` on every write-capable grant in the Alter portal, and
  alert on the `HITL VIOLATION` ERROR log line.
- **Process-local state.** Rate-limit buckets, the in-flight `listGrants`
  coalescer, and the per-session approval lock are per-process. A multi-replica
  gateway needs a shared store; today the gate assumes a single gateway process.
- **No silent IdP refresh.** Expired JWTs re-prompt sign-in rather than refresh.
- **Some backend error text reaches the agent.** Policy-violation and
  invalid-request messages from Alter, and an approved action's execution
  error, are relayed to the LLM so it can tell the user accurately; this
  assumes those messages are user-safe. Other 4xx/5xx detail goes only to the
  gateway log.

Found a vulnerability? See **[SECURITY.md](./SECURITY.md)** — please don't open
a public issue.

## Build / test

```sh
pnpm install
pnpm build          # tsc → dist/
pnpm typecheck
pnpm test           # vitest — unit tests covering the security primitives
```

## Limitations (0.x)

These are **explicit non-goals** for now:

- **No auto-resume after HITL.** After approving in the wallet, the user asks
  again; the plugin checks the approval's status. (`/alter status clear`
  clears a lock that is stuck.)
- **No silent IdP refresh.** When a JWT expires, user is re-prompted to sign
  in. A refresh-token flow is not implemented yet.
- **No per-user LLM billing.** OpenClaw's model-provider plugin holds one
  LLM key; the operator pays for all LLM calls.
- **No MCP server mode.** The whole identity gate is built around OpenClaw's
  session/channel model; MCP transports need a different identity binding.
  Deferred.
- **Per-day rate-limit only** (no per-minute). The counter increments
  post-call so per-day caps tolerate the burst at the cap edge.

## Files

- `src/` — TypeScript source. `src/index.ts` is the composition root; stores
  live in `src/identity/`, `src/grants/`, `src/rate-limit/`; crypto in
  `src/crypto/`; the central tool wrapper in `src/tools/base.ts`.
- `tests/` — vitest unit tests for the security primitives.
- `openclaw.plugin.json` — manifest (id, configSchema with
  `additionalProperties: false`).
- `OPERATOR_SETUP.md` — provisioning recipe (read this before installing).

## License

MIT.
