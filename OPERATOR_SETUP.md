# Operator Setup — `@alter-ai/openclaw-plugin`

End-to-end provisioning recipe. Reading this top-to-bottom is the only way
the plugin actually runs. Estimated time: **30-45 minutes** the first time,
~5 minutes for subsequent deployments once you have the IdP + Alter account
set up.

## How sign-in works

Users never type credentials into the chat or into this plugin. When a user
needs to sign in, the plugin asks Alter for a one-time link
(`App.createAuthSession`). The user opens it, signs in on **Alter's hosted
page through your identity provider**, and Alter returns their session to the
plugin in the background (`App.pollAuthSession`). Alter verifies the user's
token (signature, issuer, audience, expiry, key rotation); the plugin stores
it encrypted and never handles IdP credentials. All IdP configuration lives in
Alter, so the plugin itself has no IdP settings.

## Prerequisites

- An OpenClaw deployment running on a host with **Node ≥ 22** (the plugin uses
  `node:sqlite`, the Node-22+ built-in).
- A public HTTPS URL for the OpenClaw deployment (`publicBaseUrl`). OpenClaw's
  HTTP listener fronts the plugin's one route, `/alter/connect/cb`, where
  users land after connecting a provider account.
- Organization-admin access to the Alter Developer Portal
  ([portal.alterauth.com](https://portal.alterauth.com), or your self-hosted
  equivalent). The identity-provider page is admin-only.
- An identity provider Alter supports for end-user sign-in: Auth0, Clerk,
  Okta, WorkOS, or a custom OIDC provider (see Alter's
  [identity provider guide](https://docs.alterauth.com/admin/identity-provider)).
- Optional: a Google Cloud project if you'd rather use your own Google OAuth
  app than Alter's managed one, and a Tavily account for web search.

## Step 1 — Register the Alter app

In the Alter Developer Portal:

1. Create a new **App** (any name; this is your "OpenClaw deployment" identity
   in Alter). Note the `app_id`.
2. Under **API Keys**, mint two keys:
   - An **App key** (a runtime key, `alter_rk_…`; legacy deployments may show
     `alter_key_…`). Used by the plugin's `App` client for sign-in and for
     per-user `listGrants` / `revokeGrant`.
   - An **Agent key** (`alter_ak_…`; legacy deployments may show
     `alter_key_…`). Used by the plugin's `Agent` for `proxyRequest` (the
     actual tool execution path).

   Mint both keys from the **same** app, and give each one every scope in
   this table. A key that is missing one still loads; the failure only shows
   up when a user reaches the call that needs it.

   | Key | Scope | Needed for |
   |---|---|---|
   | App | `idp_users:write` | Creating sign-in links |
   | App | `idp_users:read` | Noticing that a user finished signing in |
   | App | `grants:read` | `/alter connections` and the `/alter connect` menu |
   | App | `grants:admin` | `/alter connections revoke` |
   | Agent | `proxy:execute` | Every tool call, and approval status checks |
   | Agent | `grants:read` | Finding a user's existing connection |
   | Agent | `connect:initiate` | Creating connect links |
   | Agent | `grants:write` | Creating connect links (needed together with `connect:initiate`) |
   | Agent | `identity:resolve` | The memory tools |

## Step 2 — Connect your identity provider

On the app's **Identity** page, set up both layers Alter's hosted sign-in
needs. Alter's [identity provider guide](https://docs.alterauth.com/admin/identity-provider)
has the per-provider details; in short:

1. **JWT verification.** **Add Identity Provider**, paste your IdP's issuer
   URL, **Discover**, and enter the audience the guide gives for your
   provider.
2. **OIDC sign-in.** Create a web application in your IdP, then paste its
   client ID and secret into the **User Authentication (OIDC)** section.
3. **Callback URLs.** Register both callback URLs the portal shows for the
   provider (the SDK callback ending in `/sdk/auth/callback` and the Wallet
   callback ending in `/api/auth/callback`) with your IdP, exactly as shown.

> **Do this before anyone signs in.** Alter locks the claim mappings once the
> first user is resolved; changing them afterwards means deleting and
> re-creating the provider.

## Step 3 — Allow the Connect return URL

After a user connects a provider account, Alter redirects their browser to
`https://<your-publicBaseUrl>/alter/connect/cb` (with a signed `state`
parameter). If your app's Connect settings in the portal list allowed return
URLs, add that URL there.

## Step 4 — Configure the provider integrations

On the app's **OAuth** page, add each provider whose tools you want
(Google, Slack, GitHub, Linear, Notion, Calendly, LinkedIn, X). Where the card
offers **managed credentials**, Alter's own OAuth app works with no provider
console setup. To use your own OAuth app instead, register a client with the
provider, add the **Redirect URI shown in the Alter portal** to its allowed
callbacks, and paste the client ID and secret into Alter. See Alter's
[OAuth provider reference](https://docs.alterauth.com/reference/oauth-providers)
for each provider.

Google scopes the bundled tools need:

- `https://www.googleapis.com/auth/gmail.readonly` (search and read mail)
- `https://www.googleapis.com/auth/gmail.send` (send mail)
- `https://www.googleapis.com/auth/calendar.events` (list and create events)
- `https://www.googleapis.com/auth/drive.readonly` (search and read Drive files)

## Step 5 — Configure the Tavily managed secret

(Skip this if you don't need web search.)

On the app's **Managed Secrets** page → **Add Managed Secret**:

1. Provider: `tavily`.
2. Paste the API key from https://app.tavily.com.

The Tavily tool uses Alter's managed-secret flow (one shared key, per-user
attribution), not OAuth.

## Step 6 — Generate the local-encryption secrets

The plugin needs two random 32-byte secrets for at-rest encryption and HMAC
state signing. **Both are 64 hex chars (32 bytes).** Generate them once and
treat them like database passwords:

```sh
openssl rand -hex 32  # one for OPENCLAW_ALTER_DB_KEY
openssl rand -hex 32  # one for OPENCLAW_ALTER_STATE_HMAC_SECRET
```

Also generate a per-deployment salt for hashing channel user IDs in logs:

```sh
openssl rand -hex 32  # one for `channelHashSalt` (in plugin config, not env)
```

## Step 7 — Set the four env vars on the OpenClaw host

Whichever way OpenClaw's process loads its environment (systemd unit,
docker-compose, k8s secret, etc.), make sure these four are set:

| Env var | Value |
|---|---|
| `OPENCLAW_ALTER_AGENT_API_KEY` | agent key (`alter_ak_…`) from step 1.2 |
| `OPENCLAW_ALTER_APP_API_KEY` | app runtime key (`alter_rk_…`) from step 1.2 |
| `OPENCLAW_ALTER_DB_KEY` | hex from step 6 |
| `OPENCLAW_ALTER_STATE_HMAC_SECRET` | hex from step 6 |

The plugin reads these by *name* (the names are configurable too — see
`agentApiKeyEnv`, `appApiKeyEnv`, `dbEncryptionKeyEnv`, `stateHmacSecretEnv`
in the plugin config). Storing the *values* in plugin config is deliberately
not supported — `openclaw plugins config` would dump them.

## Step 8 — Install and configure the plugin

```sh
# from the OpenClaw deployment dir:
openclaw plugins install @alter-ai/openclaw-plugin
```

Then set the plugin config. Either via the OpenClaw config UI or by editing
the workspace's plugin config JSON directly — the schema is
`openclaw.plugin.json`'s `configSchema` (validated with
`additionalProperties: false`, so typos fail at install time). Only two keys
are required:

```json
{
  "alter": {
    "publicBaseUrl": "https://openclaw.acme.example",
    "channelHashSalt": "…hex from step 6…",
    "rateLimitInputTokensPerDay": 200000,
    "rateLimitOutputTokensPerDay": 50000
  }
}
```

Defaults you don't need to set:
- `baseUrl` — defaults to Alter's production backend. Override only for
  self-hosted Alter.
- `walletBaseUrl` — defaults to `https://wallet.alterauth.com`.
- `agentApiKeyEnv`, `appApiKeyEnv`, `stateHmacSecretEnv`, `dbEncryptionKeyEnv`
  — default to the names in step 7; override only if you want a different
  naming scheme.
- `rateLimitInputTokensPerDay` / `rateLimitOutputTokensPerDay` — default to
  the values shown above.

## Step 8.5 — Allowlist the plugin's tools to the agent

OpenClaw's tool profile (default: `coding`) doesn't auto-include third-party
plugin tools. Run this once after install — it reads the plugin's tool
registry and adds every `alter_*` tool to `tools.alsoAllow` for you:

```sh
openclaw alter enable-tools
# (pass --dry-run first to see the patch before applying)
```

If you skip this, the agent loads the plugin and registers the tools with the
gateway, but the LLM never sees them — it'll confabulate things like "the
alter_gmail_search tool isn't loaded in this session's toolset" because, from
its perspective, it isn't. (The reference Fly deployment does this on every
boot, so it needs no manual step.)

## Step 9 — Restart OpenClaw and smoke-test

```sh
openclaw restart        # or however you bounce your deployment
openclaw plugins list   # should show `alter` registered
```

In your chat client (Slack / WebChat / etc.), as a real team member:

```
/alter login
```

You should get a one-time link (it expires in 10 minutes). Open it, sign in on
Alter's hosted page through your IdP, then come back to the chat. The plugin
picks up the session in the background; there is no confirmation message, so
just carry on. Then:

```
/alter connect google
```

Open the link → OAuth consent → "google connected" success page. Then ask the
agent something it'll use a tool for:

> @OpenClaw what's on my calendar today?

The agent should call `alter_gcal_list_events` and reply with your real
calendar.

## Operator CLIs

The plugin registers these commands under `openclaw alter`:

```sh
# Sign in as the operator from a terminal (for testing without a chat
# channel). Stores the session under (channel='local', user='operator').
openclaw alter login --workspace-dir <gateway-dir>

# Add every alter_* tool to the agent's tools.alsoAllow (step 8.5).
openclaw alter enable-tools

# Re-encrypt the identity store with a new AES-256-GCM key.
# Set NEW_DB_KEY=<openssl rand -hex 32> first.
openclaw alter db-rotate-key --new-key-env=NEW_DB_KEY
# Then update OPENCLAW_ALTER_DB_KEY to the new value and restart.

# Print the runbook for rotating the Connect-state HMAC secret.
# (10-min maintenance window for in-flight Connect sessions.)
openclaw alter rotate-state-hmac

# Delete a (channel_kind, channel_user_id) link and its local grant cache.
# Use when a user's IdP `sub` has changed (account merge, deletion and
# re-creation, etc.).
openclaw alter unlink-channel-user --kind slack --user-id U042... --yes
```

## What can go wrong

| Symptom | Likely cause | Fix |
|---|---|---|
| Plugin fails to load with "missing required plugin config key: …" | Step 8 incomplete | Set the missing field in plugin config |
| Plugin fails to load with "secret env var X is missing or too short" | Step 7 incomplete | Set the env var on the gateway host, restart |
| Plugin fails to load with "api_key must be a syntactically valid Alter key" | The key in a step 7 env var is truncated or mangled (the SDK checks the full key format at boot) | Re-copy the key from the Alter portal, restart |
| A tool or `/alter` command answers "This assistant's Alter API key is missing a permission"; gateway log (ERROR) shows `the Alter API key is missing scope(s) [<scopes>]` | The app or agent key was minted without a scope from the step 1.2 table. It fails the same way for every user | Add the logged scopes to the key in the Alter portal, or mint a new key with the full set and update the step 7 env var |
| Tool calls fail with "request failed and is not retryable"; gateway log shows `code=invalid_key` or `InvalidKeyError` | Alter rejected the API key. Keys minted before Alter's September 2026 key-security upgrade can no longer authenticate; the log's `hint=` says which case | Mint a new key in the Alter portal, update the step 7 env var, restart |
| The sign-in link fails at your IdP with a redirect-URI mismatch | Alter's callback URLs aren't registered with the IdP exactly as shown | Step 2.3 — register both URLs, character for character |
| Sign-in succeeds but tool calls keep answering "Alter rejected your sign-in" with a new link; gateway log shows `sign-in token rejected by Alter: JWT validation failed: <reason>` | The issuer or audience configured in Alter doesn't match the tokens your IdP issues (the `<reason>` names which) | Re-check step 2.1 against Alter's identity provider guide for your IdP |
| Same as above, but it started suddenly for every user and the `<reason>` is `JWKS fetch failed: …`, `JWKS endpoint returned invalid JSON`, or `OIDC discovery request failed …` | Alter can't reach your IdP's signing keys (IdP outage or network problem). Alter reports this as a rejected sign-in, so the plugin offers new links, but signing in again won't help until the IdP recovers | Check the IdP's status and its JWKS URL. Tell users to wait rather than sign in repeatedly; it clears on its own once Alter can fetch the keys |
| Users are asked to sign in again often | The stored session token has expired; the plugin re-prompts rather than refreshing silently | Lengthen the token lifetime in your IdP |
| Tool replies "…couldn't start the sign-in flow. Try again shortly."; gateway log shows `could not start a sign-in: <error>` | Alter refused to create the sign-in session (the `<error>` says why, e.g. an `InvalidKeyError` with a `hint=`) | Fix what the logged error names; for a key error see the `invalid_key` row above |
| `/alter connect google` link returns "No matching grant" | The OAuth flow didn't complete, or completed for a different user | Run `/alter connect google` again; if Alter's portal shows a fresh grant for the user anyway, file an issue |
| Tool calls return "Awaiting your approval" then nothing happens | HITL — go to your wallet, approve, then re-ask the agent | (working as intended) |
| Tool returns "This needs N separate approvals" with several links | The grant's policy requires more than one approver; the action runs only after every one approves | Each approver opens their own link (working as intended) |
| Tool calls return "You have a pending approval" forever | Stale lock | `/alter status clear` |

## Maintenance

- **Backup the SQLite file.** Lives at `<workspaceDir>/.alter/plugin.sqlite`.
  Holds encrypted JWTs, grant cache, rate-limit counters. Lose it and every
  user has to `/alter login` + `/alter connect` again — no data loss in Alter
  itself, but a UX hit.
- **Rotate `OPENCLAW_ALTER_DB_KEY` annually** via `openclaw alter db-rotate-key`.
- **Rotate `OPENCLAW_ALTER_STATE_HMAC_SECRET` annually** via the runbook
  (`openclaw alter rotate-state-hmac` prints the steps; in-flight Connect
  sessions break for ~10 min, document the maintenance window).
- **Don't leak the env vars.** They're not in plugin config for a reason; if
  you ever find yourself running `openclaw plugins config` and seeing a key,
  something has gone wrong.
