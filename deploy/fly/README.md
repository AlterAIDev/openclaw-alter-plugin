# Fly.io deployment runbook

Deploys the OpenClaw gateway + `@alter-ai/openclaw-plugin` to Fly.io as a
single long-running machine with a persistent volume, then connects it to
**Slack, Discord, or both** in Phase 2. Each chat platform turns on when its
secrets are set; nothing in the image or config has to change.

Estimated time: **20-30 min** for the first deploy, ~3 min for subsequent
`fly deploy` runs.

## Files in this directory

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build: compiles the plugin, then packages it next to a pinned openclaw release (kept in lockstep with `@openclaw/slack` — see the version pinned in the Dockerfile) in a Node 22 runtime image (with `python3`/`make`/`g++` so `@openclaw/slack`'s native deps can build at boot). |
| `entrypoint.sh` | Container entrypoint. Seeds `/data/openclaw.json` from the template, installs the OpenAI key, the alter plugin and the plugin for each chat platform whose secrets are set (skipped on a restart when nothing changed), then execs `openclaw gateway`. |
| `config-reconcile.cjs` | Run by the entrypoint on every boot: syncs the agent's tool allowlist with the plugin manifest, and turns Slack/Discord on or off from their secrets. Unit-tested in `tests/deploy-config-reconcile.test.ts`. |
| `smoke-test.sh` | Builds the image and boots it in Docker for each chat setup with placeholder secrets (see "Testing changes to this deployment"). |
| `openclaw.json.template` | Gateway config. `__PUBLIC_BASE_URL__` and `__CHANNEL_HASH_SALT__` are substituted at container start. |
| `../../fly.toml` | App definition (lives at the plugin root). |
| `../../.dockerignore` | Keeps the build context lean. |

## Prerequisites

Before running anything in this runbook, have these in hand:

- **flyctl installed + logged in.** `brew install flyctl && fly auth login`.
- **An Alter app already registered** with two API keys minted (agent + app),
  per `../../OPERATOR_SETUP.md` step 1, and your identity provider connected
  per step 2. Both keys must come from the same Alter app and carry the
  scopes listed in step 1.2. You need:
  - an agent key (`alter_ak_…`; legacy `alter_key_…`)
  - an app runtime key (`alter_rk_…`; legacy `alter_key_…`)
- **Two 64-hex-char random values** for the HMAC + DB encryption secrets:
  ```sh
  openssl rand -hex 32   # OPENCLAW_ALTER_STATE_HMAC_SECRET
  openssl rand -hex 32   # OPENCLAW_ALTER_DB_KEY
  ```
- **A 32+ hex char channelHashSalt** (mixed into log-correlation hashes):
  ```sh
  openssl rand -hex 32   # CHANNEL_HASH_SALT
  ```
- **An OpenAI API key** (`sk-…`) for the gateway's main agent. (To swap
  providers, change the model pin in `openclaw.json.template` **and** the
  entrypoint's `paste-api-key --provider openai` step, which installs the
  credential — `auth.profiles` in the template is intentionally `{}` because
  declaring a profile there does not install a key. See `entrypoint.sh`.)
> **Note**: you do NOT need to provide `OPENCLAW_GATEWAY_TOKEN`. The entrypoint
> auto-generates one on first boot at `/data/.gateway-token` and persists it.
> No external client uses it (Slack/Discord reach the bot via their own
> transports); it exists solely to satisfy OpenClaw's safety check that
> non-loopback binds must have an auth mode configured.

Save the five values above somewhere secure (1Password, a `.env` you'll
delete) — you'll paste them into `fly secrets set` in step 3.

---

## Phase 1 — Deploy the gateway

### 1. Pick a unique app name + region

Fly app names are global. Pick one, then edit `fly.toml`:

```toml
app = "your-org-openclaw"    # globally unique — pick your own
primary_region = "iad"        # iad/sjc/lhr/fra — pick close to you
```

Volume name (`openclaw_data` under `[mounts]`) is fine to leave alone.

### 2. Create the app + volume

From the plugin root:

```sh
fly apps create <your-app-name>
fly volumes create openclaw_data --size 3 --region <your-region> --app <your-app-name>
```

3 GB is plenty for SQLite + workspace state; bump later if you hit it.

### 3. Push secrets

```sh
fly secrets set \
  OPENAI_API_KEY="sk-…" \
  OPENCLAW_ALTER_AGENT_API_KEY="alter_ak_…" \
  OPENCLAW_ALTER_APP_API_KEY="alter_rk_…" \
  OPENCLAW_ALTER_STATE_HMAC_SECRET="<64 hex chars>" \
  OPENCLAW_ALTER_DB_KEY="<64 hex chars>" \
  CHANNEL_HASH_SALT="<32+ hex chars>" \
  --app <your-app-name>
```

Fly stores these encrypted and exposes them as env vars to the container.
**Do not paste these into `openclaw.json`** — the plugin's `secrets.ts`
reads only from env, and putting keys in the config file would leak them
into `openclaw plugins config` output.

### 4. First deploy

```sh
fly deploy --app <your-app-name>
```

First build is ~3-4 min (pnpm install + tsc + apt). Subsequent deploys
are ~1 min.

Verify:

```sh
fly status --app <your-app-name>
fly logs --app <your-app-name>
```

You're looking for these lines, in order:

```
[entrypoint] seeding /data/openclaw.json from template (v<N>)
[entrypoint] wiring OpenAI api_key auth profile openai:key-<hash> from OPENAI_API_KEY
[entrypoint] registering alter plugin
[entrypoint] reconciling chat channels with their credentials
[entrypoint] chat channels: slack on, discord off
[entrypoint] registering @openclaw/slack@<openclaw version>   ← once per enabled platform
[entrypoint] generating /data/.gateway-token       ← first boot only
[entrypoint] starting gateway
alter plugin registered (Alter-hosted sign-in flow, 29 tools + 3 memory tools)
[gateway] http server listening (9 plugins: alter, browser, …, slack, …)
[gateway] ready
```

(Shown with Slack secrets set. With none set yet, the channels line reads
`slack off, discord off` and no chat plugin is installed.)

That is a first boot, or the first boot of a new image. A plain restart skips
the three install steps and says so:

```
[entrypoint] OpenAI auth profile openai:key-<hash> already installed
[entrypoint] alter plugin already installed (build <id>)
[entrypoint] @openclaw/slack <version> already installed
[entrypoint] starting gateway
```

`fly deploy` may print "The app is not listening on the expected address"
while the machine boots. It checks the moment the machine starts, and a boot
that installs plugins takes about a minute to reach `http server listening`.
It is only a problem if that line never appears.

If the `alter plugin registered` line is missing, the plugin failed to
load — `fly logs` shows the throw. Most common causes: a missing env var
from step 3, or a truncated or mangled key (the SDK checks the key format at
boot). Swapping the agent and app keys does *not* stop the load: it shows up
as a 401 from Alter on the first call that uses them.

> **No chat secrets set yet?** That's fine: the gateway boots with every chat
> platform off, and the alter plugin still loads. Setting the secrets in
> Phase 2 restarts the machine, and that boot turns the platform on.

### 5. Register your Fly URL with Alter Vault

Your gateway is now reachable at `https://<your-app-name>.fly.dev`. The
plugin computes its OAuth callback as
`https://<your-app-name>.fly.dev/alter/connect/cb`.

In the Alter portal, for the app whose keys you used in step 3, add
`https://<your-app-name>.fly.dev/alter/connect/cb` to the app's allowed
Connect return URLs (`../../OPERATOR_SETUP.md` step 3).

Without this, `/alter connect <provider>` will fail at session-mint time
with a 400 from Alter before the user ever sees the OAuth screen.

Sign-in needs nothing from the Fly URL: it runs on Alter's hosted page, and
your identity provider only has to know Alter's callback URLs
(`../../OPERATOR_SETUP.md` step 2).

### 6. Smoke test

Open the Control UI:

```sh
fly open --app <your-app-name>
```

Sign in with the gateway token the entrypoint generated on first boot:

```sh
fly ssh console --app <your-app-name> -C 'cat /data/.gateway-token'
```

The UI should list `alter` under plugins with status enabled, and
`fly logs` should show `alter plugin registered (Alter-hosted sign-in flow,
29 tools + 3 memory tools)`. If not, re-check `fly logs`.

End of Phase 1. The gateway is alive and the plugin is loaded, but no
chat channel is wired up yet.

---

## Phase 2 — Connect Slack, Discord, or both

Pick one platform or run both from the same gateway. Each is switched on by
its own Fly secrets; on the next boot the entrypoint installs OpenClaw's
plugin for it (at the gateway's exact version) and enables it in
`/data/openclaw.json`. Remove a platform's secrets and the next boot turns it
off. You never need to SSH into the machine or edit config for this.

| Platform | Secrets | Section |
|---|---|---|
| Slack (Socket Mode) | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | Phase 2a |
| Discord | `DISCORD_BOT_TOKEN` | Phase 2b |

Either way, each person's identity, connected accounts and approvals stay
separate (see `../../README.md`, "Who sees and does what"), and DMs are
private per person because the template sets `session.dmScope:
"per-channel-peer"`.

## Phase 2a — Slack (Socket Mode)

Socket Mode means no public Slack webhook URL — the gateway opens an
outbound WebSocket to Slack and waits for events. Works behind firewalls,
no DNS surgery needed.

The Slack channel block is already in `openclaw.json.template` (open DMs,
open group policy, `/alter` slash command, `main` agent binding). All you do
in this phase is (a) create the Slack app, (b) push two tokens as Fly
secrets, (c) verify.

### 1. Create the Slack app

Open https://api.slack.com/apps → **Create New App** → **From a manifest**
→ pick your workspace → paste the manifest below → **Next** → **Create**.

```json
{
  "display_information": {
    "name": "Alter",
    "description": "OpenClaw + Alter Vault — multi-user, OAuth-gated tools."
  },
  "features": {
    "bot_user": { "display_name": "Alter", "always_online": true },
    "app_home": {
      "home_tab_enabled": true,
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/alter",
        "description": "Talk to Alter",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "chat:write",
        "commands",
        "files:read",
        "files:write",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "reactions:read",
        "reactions:write",
        "users:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_home_opened",
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added"
      ]
    }
  }
}
```

> **Do not add `assistant:write` to the bot scopes.** It opts the bot
> into Slack's AI Assistant Thread UI, which (a) shows "Couldn't load
> thread" in the DM, and (b) routes DMs through assistant-specific events
> that `@openclaw/slack` does not currently subscribe to — so `message.im`
> events stop arriving entirely and the bot goes silent. If you copy a
> manifest from the OpenClaw docs that includes `assistant:write`, remove
> it before saving.

### 2. Install the app and mint the two tokens

After Slack creates the app:

a. **Settings → Install App → Install to Workspace** → approve scopes.
   Then copy the **Bot User OAuth Token** (starts with `xoxb-`).

b. **Settings → Basic Information → App-Level Tokens → Generate Token
   and Scopes**. Name it `socket`. Add scope `connections:write`. Click
   Generate. Copy the token (starts with `xapp-`). You can only see the
   value once — store it now.

c. **Features → App Home** → scroll to **Show Tabs** → tick **"Allow
   users to send Slash commands and messages from the messages tab"** →
   **Save Changes**. *Without this, Slack shows "Sending messages to this
   app has been turned off" in the DM and no message is ever sent.*

d. **Settings → Socket Mode** → verify the top toggle is **Enabled**.

e. **Features → Event Subscriptions** → verify the top toggle is
   **Enabled** (separate from Socket Mode; required even in Socket Mode)
   and that the bot events list matches the manifest.

### 3. Push the Slack secrets to Fly

```sh
fly secrets set \
  SLACK_BOT_TOKEN='xoxb-…' \
  SLACK_APP_TOKEN='xapp-…' \
  --app <your-app-name>
```

> Use single quotes around the tokens so your shell doesn't interpret
> any `$` or `!` characters in them. If `fly` errors with
> `must be in the format NAME=VALUE`, you have a stray space after a `\`
> line-continuation — keep both `KEY=VALUE` pairs on one line.

Without `--stage`, Fly will restart the machine with the new env. With
`--stage`, secrets are queued for the next deploy.

### 4. Verify

After restart (or after your next `fly deploy`):

```sh
fly logs --app <your-app-name> | grep -iE 'slack'
```

You want to see, in order:

```
[entrypoint] chat channels: slack on, …
[entrypoint] registering @openclaw/slack@<openclaw version>
[gateway] http server listening (9 plugins: alter, browser, …, slack, …)
[slack] [default] starting provider
[slack] socket mode connected
```

(The plugin installs on the first boot with Slack secrets; later restarts
say `@openclaw/slack <version> already installed`.)

Then DM the bot in Slack with anything (e.g. `hi`). Within a second,
new lines should appear in `fly logs`:

```
[slack] … received message … channel=D… user=U… text=hi
```

If you see those — the bot is live end-to-end. First time you talk to
it the alter plugin will surface the `/alter login` URL; click through
the Alter sign-in flow, return to Slack, and continue.

### 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Slack DM shows *"Sending messages to this app has been turned off"* | App Home → Messages Tab → "Allow users to send" is off | Step 2c above. |
| Slack DM shows *"Couldn't load thread"* | `assistant:write` scope is in the manifest | Edit manifest, remove the scope, **Reinstall to Workspace**. |
| `socket mode connected` appears in logs but DMs never reach gateway | Bot token / app token mismatch, OR you changed the manifest without reinstalling | Step 2a — copy the *current* `xoxb-` from Install App page, `fly secrets set` again, restart machine. Then reinstall the app. |
| Logs show `Socket Mode is not turned on.` warning right before `socket mode connected` | Cosmetic Slack SDK noise; ignore unless followed by a real error. | None. |
| `slack failed during register: TypeError: createSetupTranslator is not a function` | Dockerfile's openclaw pin is older than `@openclaw/slack` requires | Bump `RUN npm install -g openclaw@<version>` in `Dockerfile` to match the slack plugin's npm version (they're released in lockstep). |
| `Error: spawn python3 ENOENT` during `Installing @openclaw/slack` | Runtime image missing python3 + build tools (needed by `node-gyp` for native WebSocket deps) | Already fixed in current `Dockerfile`; re-deploy from clean tip. |
| `WARNING The app is not listening on the expected address` from `fly deploy` and gateway never binds | Gateway crashed before binding — usually because the slack plugin install FATALed. | Read `fly logs` upward from the warning; the real error is above. |

### 6. Reinstall etiquette

Any time you edit the Slack app manifest (scopes, events, slash commands,
App Home), you must:

1. Save the manifest.
2. **Settings → Install App → Reinstall to Workspace** — re-approve scopes.
3. Copy the (possibly new) `xoxb-` bot token from that page.
4. `fly secrets set SLACK_BOT_TOKEN='xoxb-…' --app <your-app-name>` (no
   `--stage`, so the machine restarts and picks up the new token).

Forgetting any of steps 2–4 produces the silent-bot symptom from the
troubleshooting table above.

---

## Phase 2b — Discord

OpenClaw connects to Discord as a bot over Discord's gateway, so like Socket
Mode there is no public webhook. All you do here is (a) create the bot,
(b) invite it to your team's server, (c) push one token as a Fly secret,
(d) verify.

### 1. Create the Discord application and bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications),
   **New Application** → name it (for example "Alter").
2. **Bot** in the sidebar → set the bot's **Username**.
3. Still on **Bot**, under **Privileged Gateway Intents**, enable:
   - **Message Content Intent** (required: without it the bot can't read
     messages in server channels)
   - **Server Members Intent** (recommended: needed for role- and
     member-based allowlists if you tighten access later)
4. **Reset Token** → copy the bot token. You only see it once.

### 2. Invite the bot to your server

**OAuth2** → **OAuth2 URL Generator**:

- Scopes: `bot` and `applications.commands` (the second registers `/alter`
  as a Discord slash command)
- Bot permissions: **View Channels**, **Send Messages**, **Send Messages in
  Threads**, **Read Message History**, **Embed Links**, **Attach Files**
  (and **Add Reactions** if you like)

Open the generated URL, choose your team's server, and **Continue**. Invite
the bot only to servers whose members should be able to use it (see step 5).

So people can DM the bot: right-click the server icon → **Privacy Settings**
→ turn on **Direct Messages**.

### 3. Push the Discord secret to Fly

```sh
fly secrets set DISCORD_BOT_TOKEN='…' --app <your-app-name>
```

The machine restarts. That boot installs `@openclaw/discord` at the
gateway's version and adds a Discord block to `/data/openclaw.json` with the
team defaults (step 5).

### 4. Verify

```sh
fly logs --app <your-app-name> | grep -iE 'discord|chat channels'
```

You want to see:

```
[entrypoint] chat channels: …, discord on (config updated)
[entrypoint] registering @openclaw/discord@<openclaw version>
[gateway] http server listening (… discord …)
```

Then, in Discord:

- **DM the bot** "hi". It replies; the first time you ask it to do
  something, it sends you a sign-in link.
- **In a server channel, @mention it** ("@Alter what's on my calendar?"). In
  server channels it only answers when mentioned.
- **Type `/alter`** — Discord offers it as a slash command. Replies to
  slash commands are visible only to you, so sign-in and connect links stay
  private even in a busy channel.

### 5. Who can use it, and tightening that

The Discord block the entrypoint adds mirrors the Slack defaults:

```json
"discord": { "enabled": true, "dmPolicy": "open", "allowFrom": ["*"], "groupPolicy": "open" }
```

Anyone who shares a server with the bot can DM it, and anyone in a server it
was invited to can @mention it. Everything Alter does still requires each
person to sign in through your identity provider, so an outsider can chat
with the model but can't reach anyone's accounts. They do use the model,
though, on your bill. To restrict who can talk to it at all, edit the
`channels.discord` block in `/data/openclaw.json` (for example
`"dmPolicy": "allowlist"` with specific user IDs in `allowFrom`, or a guild
allowlist) following OpenClaw's
[Discord access-control docs](https://docs.openclaw.ai/channels/discord/access-control).
The entrypoint keeps your edits; it only flips `enabled`.

### 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Bot is online but ignores messages in server channels | Not @mentioned, or **Message Content Intent** is off | Mention the bot; enable the intent (step 1.3) and restart the machine |
| Can't DM the bot | The server doesn't allow DMs from members | Server **Privacy Settings** → **Direct Messages** on |
| `/alter` doesn't appear | Invited without the `applications.commands` scope | Re-invite with both scopes (step 2) |
| `/alter` replies "not authorized" | OpenClaw's DM or guild policy excludes this user | Check `channels.discord` `dmPolicy` / `allowFrom` (step 5) |
| `fly logs` shows no `registering @openclaw/discord` line | `DISCORD_BOT_TOKEN` isn't set for this app | `fly secrets list --app <your-app-name>` |

End of Phase 2.

---

## After a deploy: check it end to end

The smoke test (next section) proves the image boots; only a real workspace
proves the bot works. After each deploy, on each platform you run:

1. DM the bot and ask for something that needs a tool ("what's on my
   calendar today?"). Expect a sign-in link the first time, then an answer.
2. @mention the bot in a shared channel and get a reply.
3. `/alter connect` shows the connect menu; `/alter status` shows you signed
   in.
4. Ask for a write ("email me a test message"). Expect "Awaiting your
   approval" with a Wallet link; approve; ask again; the email arrives.
5. Have a second person ask the same calendar question in the same channel:
   they get *their* calendar, or their own sign-in link.

## Testing changes to this deployment

Before deploying a change to the Dockerfile, the entrypoint, the template or
the plugin's dependencies, run:

```sh
bash deploy/fly/smoke-test.sh
```

It builds the image and boots it in Docker four times with placeholder
secrets: no chat platform, Slack only, Discord only, then a restart with
both. Each boot must accept the config, install exactly the right plugins,
load the alter plugin and start listening, and the restart must not reinstall
anything. (The placeholder tokens make Slack and Discord log auth failures;
that's expected.) It takes a few minutes and needs network access. CI runs it
on every pull request that touches the deployment. The config logic it
exercises also has fast unit tests: `pnpm test` (in
`tests/deploy-config-reconcile.test.ts`).

## Updates

After any plugin code change:

```sh
cd openclaw-alter-plugin
fly deploy --app <your-app-name>
```

The Dockerfile rebuilds, the image rolls, the machine restarts. State on
`/data` persists across deploys — users don't have to re-link or re-connect.

## Changing secrets, and why restarts are rationed

Every `fly secrets set` restarts the machine, and the bot is offline until it
has booted: messages sent in that window are lost. Change several secrets in
one go, or stage them and let the next deploy apply them:

```sh
fly secrets set --stage A='…' B='…' --app <your-app-name>
fly deploy --app <your-app-name>          # or: fly secrets deploy
```

The machine is a shared-CPU size. Fly gives those a CPU burst budget and
throttles the machine to a fraction of a core once it is spent. A boot that
installs plugins is the most CPU-heavy thing the container does, so several
full boots close together can spend the budget; the next boot then takes
several minutes and the gateway stalls for seconds at a time. The entrypoint
avoids this by skipping installs that are already on the volume, but every
`openclaw …` command run over `fly ssh` also costs CPU. If the bot turns slow
after a burst of restarts, check the budget before restarting again:

- Fly dashboard → the app → Metrics → **CPU** shows throttling and balance.
- It refills on its own while the machine is idle. Leave it alone.

### Replacing the OpenAI key

```sh
fly secrets set OPENAI_API_KEY='sk-…' --app <your-app-name>
```

Nothing else is needed. The entrypoint installs each key under its own auth
profile, so a new key never inherits the old key's billing lockout (OpenClaw
disables a profile for 5-24 hours after a "no credits" error and remembers it
on the volume). Do not run `openclaw models auth login` on the machine for
this: it needs a terminal and installs an extra plugin.

### Troubleshooting a live gateway

| Symptom | Cause | Fix |
|---|---|---|
| Bot answers "API provider returned a billing error" | The OpenAI account behind `OPENAI_API_KEY` has no credits. Once it happens, OpenClaw stops trying that key for 5-24 hours | Add credits and wait out the lockout, or set a key from a funded account (see above) |
| Bot answers "This assistant's Alter API key is missing a permission" | An Alter key was minted without a required scope; `fly logs` names the scope at ERROR level | Add the scope in the Alter portal (`OPERATOR_SETUP.md` step 1.2) |
| Boot takes minutes; replies lag; `/alter` says "the app did not respond" | CPU throttled after several full boots in a row | Stop restarting and let the budget refill, or move to a `performance` machine size |
| Bot answers one message, then is silent for several minutes; `fly logs` shows `stuck session` or `reply session initialization conflicted` | Known fault in OpenClaw 2026.6.11's session handling; it clears itself within about 6 minutes | Send one message at a time and wait for the reply. Restarting does not fix it |

## Rolling back

```sh
fly releases --app <your-app-name>
fly releases rollback <release-id> --app <your-app-name>
```

## Tearing down

```sh
fly apps destroy <your-app-name>
```

This deletes the app, the machine, and the volume. Alter-side state (the
app, its grants, its users) is unaffected — that lives in Alter Vault.

## Cost

`shared-cpu-2x` + 2 GB RAM + 3 GB volume runs ~$8-12/mo at idle. See
https://fly.io/docs/about/pricing/ for the live numbers.
