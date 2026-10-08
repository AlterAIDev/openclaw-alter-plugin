# Fly.io deployment runbook

Deploys the OpenClaw gateway + `@alter-ai/openclaw-plugin` to Fly.io as a
single long-running machine with a persistent volume. Slack wires up after
the gateway is green (Phase 2 below).

Estimated time: **20-30 min** for the first deploy, ~3 min for subsequent
`fly deploy` runs.

## Files in this directory

| File | Purpose |
|---|---|
| `Dockerfile` | Multi-stage build: compiles the plugin, then packages it next to a pinned openclaw release (kept in lockstep with `@openclaw/slack` — see the version pinned in the Dockerfile) in a Node 22 runtime image (with `python3`/`make`/`g++` so `@openclaw/slack`'s native deps can build at boot). |
| `entrypoint.sh` | Container entrypoint. Seeds `/data/openclaw.json` from the template, installs the OpenAI key and the two plugins (skipped on a restart when nothing changed), then execs `openclaw gateway`. |
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
alter plugin registered (Alter-hosted sign-in flow, 29 tools + 3 memory tools)
[entrypoint] registering @openclaw/slack@<openclaw version>
[entrypoint] generating /data/.gateway-token       ← first boot only
[entrypoint] starting gateway
[gateway] http server listening (9 plugins: alter, browser, …, slack, …)
[gateway] ready
```

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

> **Slack secrets not set yet?** The gateway still boots and the alter
> plugin still loads — the Slack channel start will log auth errors and
> stay down. You'll fix that in Phase 2 (the next boot picks them up).
> Recommended: complete Phase 2 *before* your first `fly deploy` so the
> first boot has tokens ready.

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

## Phase 2 — Wire Slack (Socket Mode)

Socket Mode means no public Slack webhook URL — the gateway opens an
outbound WebSocket to Slack and waits for events. Works behind firewalls,
no DNS surgery needed.

The Slack channel block is already in `openclaw.json.template` (open DMs,
open group policy, `/alter` slash command, `main` agent binding) — you do
**not** need to SSH into the machine and edit `/data/openclaw.json`. All
you do in this phase is (a) create the Slack app, (b) push two tokens as
Fly secrets, (c) verify.

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
[gateway] http server listening (9 plugins: alter, browser, …, slack, …)
[slack] [default] starting provider
[slack] socket mode connected
```

(The Slack plugin itself was installed on the first boot; a restart to pick
up the tokens does not reinstall it.)

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

End of Phase 2.

---

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
