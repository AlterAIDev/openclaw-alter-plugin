#!/bin/sh
#
# Container entrypoint. Idempotent. Each restart:
#   1. ensures /data exists (Fly mount lands here),
#   2. seeds /data/openclaw.json from the template if missing,
#   3. installs the OpenAI key as an auth profile named after the key,
#   4. installs the alter plugin, and the Slack and/or Discord plugin for each
#      chat channel whose credentials are set, unless this image's versions
#      are already on the volume,
#   5. generates/loads a persistent gateway token (--bind lan requires auth),
#   6. execs the gateway with --bind lan --auth token so Fly's edge can reach it.
#
# Steps 3 and 4 each start the openclaw CLI, which is the expensive part of a
# boot. They record what they did in a marker file under /data and are skipped
# on the next boot if nothing changed, so a plain restart costs almost nothing.
# That matters on a shared-CPU Fly machine: a few full boots in a row spend the
# CPU burst budget, and the machine is then throttled to its baseline.
#
# Anything that should differ between deploys lives in env vars or
# /data/openclaw.json — NOT in this script.
set -eu

STATE_DIR="${OPENCLAW_STATE_DIR:-/data}"
mkdir -p "${STATE_DIR}"

# Agent workspace lives on the persistent volume (pinned via
# agents.defaults.workspace in openclaw.json.template) so it survives
# redeploys. Without this the workspace defaults to ~/.openclaw/workspace on
# the ephemeral container fs, which is wiped on every deploy while its
# attestation persists under /data — producing WorkspaceVanishedError (and a
# dead bot) on the next boot.
mkdir -p "${STATE_DIR}/workspace"

CONFIG_PATH="${STATE_DIR}/openclaw.json"

# Sentinel file tracks the template version we seeded. Re-seed if the
# config file is missing OR the sentinel's missing OR the sentinel's
# version is older than what's in the image. We can't put the marker
# inside openclaw.json itself — openclaw's schema rejects unknown keys.
#
# Operators who hand-edit /data/openclaw.json should `touch` the
# sentinel with the current image's TEMPLATE_VERSION so we don't
# clobber their changes on the next boot.
#
# Bump TEMPLATE_VERSION whenever the seeded config must change on already-
# running volumes: the re-seed is sentinel-gated, so without a bump the volume
# keeps its old config forever and the change never lands.
#
# Version 16 encodes two things that ship together:
#
#   1. SECURITY — session.dmScope: "per-channel-peer". OpenClaw's dmScope
#      defaults to "main", routing EVERY user's DM into ONE shared session: one
#      transcript readable by everyone who DMs the bot. Docs (concepts/session,
#      "DM isolation") warn verbatim: "Without it, all users share the same
#      conversation context, so Alice's private messages would be visible to
#      Bob"; gateway/security says to set session.dmScope: "per-channel-peer"
#      when multiple people can DM the bot (open DMs / multi-person allowlist) —
#      exactly this config (dmPolicy:"open", allowFrom:["*"]). Left at the
#      default, `openclaw sessions list` shows a single `direct` session,
#      `agent:main:main`, holding every user's history, and the bot will read
#      one user's messages back to another. "per-channel-peer" gives each
#      (channel, sender) its own DM context.
#
#      dmScope only re-scopes NEW sessions. The existing agent:main:main and its
#      multi-user transcript must be retired separately or it stays reachable,
#      and there is NO `openclaw sessions delete` (and `sessions cleanup
#      --fix-dm-scope` does NOT retire it): remove the `agent:main:main` entry
#      from /data/agents/main/sessions/sessions.json, delete its `<sessionId>.*`
#      transcript files, then restart. This is a messaging-context boundary, not
#      a host-admin one — mutually adversarial users need separate gateways.
#      See docs/MULTI_USER_LIMITS.md ("Migrating a gateway that ran without
#      dmScope").
#
#   2. MODEL + AUTH — openai/gpt-5.5 (primary) + openai/gpt-5.4 (fallback). The
#      OpenAI platform key is installed as an api_key auth profile by the
#      paste-api-key step further below, NOT declared here: auth.profiles in the
#      template is intentionally {} because declaring a profile does not install
#      a credential. See that step for the full rationale.
#
# dmScope has been "per-channel-peer" since v14.
TEMPLATE_VERSION=16
SENTINEL="${STATE_DIR}/.alter-template-v${TEMPLATE_VERSION}"
# Set when this boot rewrote the config. The auth-profile and plugin-install
# steps below also write to openclaw.json, so a re-seed wipes their entries and
# they must run again whatever their marker files say.
RESEEDED=0
if [ ! -f "${CONFIG_PATH}" ] || [ ! -f "${SENTINEL}" ]; then
  RESEEDED=1
  echo "[entrypoint] seeding ${CONFIG_PATH} from template (v${TEMPLATE_VERSION})"
  # Clean any older sentinel from a previous template version.
  rm -f "${STATE_DIR}"/.alter-template-v*
  # publicBaseUrl is what the alter plugin uses to build its OAuth
  # callback URL. We substitute it at boot from FLY_APP_NAME so the
  # operator doesn't have to hand-edit the template per deploy.
  PUBLIC_BASE_URL_VALUE="${PUBLIC_BASE_URL:-https://${FLY_APP_NAME:-localhost}.fly.dev}"
  CHANNEL_HASH_SALT_VALUE="${CHANNEL_HASH_SALT:?CHANNEL_HASH_SALT must be set (32+ random hex chars)}"
  # OpenClaw registers the plugin's tools but keeps them INVISIBLE to the agent
  # unless they're in tools.alsoAllow (the default "full" profile does not cover
  # plugin-contributed tools — see docs/DEVELOPMENT.md). Derive the allowlist
  # straight from the manifest's contracts.tools so it can never drift when a
  # tool is added.
  ALTER_TOOLS_ALLOW="$(node -e 'const m=require("/app/plugin/openclaw.plugin.json");process.stdout.write(JSON.stringify((m.contracts&&m.contracts.tools)||[]))')"
  [ -n "${ALTER_TOOLS_ALLOW}" ] || ALTER_TOOLS_ALLOW="[]"
  sed \
    -e "s|__PUBLIC_BASE_URL__|${PUBLIC_BASE_URL_VALUE}|g" \
    -e "s|__CHANNEL_HASH_SALT__|${CHANNEL_HASH_SALT_VALUE}|g" \
    -e "s|\"__ALTER_TOOLS_ALLOW__\"|${ALTER_TOOLS_ALLOW}|g" \
    /app/openclaw.json.template > "${CONFIG_PATH}"
  touch "${SENTINEL}"
fi

# Reconcile tools.alsoAllow with the plugin manifest on EVERY boot.
#
# This runs OUTSIDE the seed block on purpose. The allowlist used to be derived
# only while seeding, which meant it refreshed only on a TEMPLATE_VERSION bump:
# add a tool, deploy, forget the bump, and the tool registers but stays INVISIBLE
# to the agent — with no error anywhere. The manual workaround
# (`openclaw alter enable-tools`, see docs/DEVELOPMENT.md) was a trap with a
# sign next to it. Deriving it every boot deletes the trap: the manifest
# is the single source of truth, and shipping a tool is enough to expose it.
#
# Merge semantics: alter_* entries are replaced wholesale from the manifest (so
# REMOVING a tool also takes effect), while any non-alter_* entry an operator
# added by hand is preserved. Only writes when something actually changed, so a
# steady-state boot is silent.
echo "[entrypoint] reconciling tools.alsoAllow with the plugin manifest"
node /app/config-reconcile.cjs tools "${CONFIG_PATH}" /app/plugin/openclaw.plugin.json || {
  echo "[entrypoint] FATAL: could not reconcile tools.alsoAllow — the agent would" >&2
  echo "[entrypoint]        boot with a stale/absent tool allowlist and silently" >&2
  echo "[entrypoint]        lose access to alter tools. Refusing to start." >&2
  exit 1
}

# True when marker file $1 holds exactly $2 and this boot did not re-seed.
marker_matches() {
  [ "${RESEEDED}" = 0 ] && [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]
}

# Wire the OpenAI platform API key into an openclaw auth profile.
#
# This is NOT optional plumbing — without it the bot 401s on every turn. Two
# openclaw facts make it necessary:
#   1. The `openai` provider DEFAULTS to ChatGPT/Codex OAuth login
#      (chatgpt.com/backend-api/codex/responses), which needs a subscription
#      ACCESS TOKEN — not the platform OPENAI_API_KEY. So a bare openai model
#      pin routes to the Codex backend and fails "401 Invalid access token".
#   2. Declaring `auth.profiles` in openclaw.json does NOT materialize a
#      credential — `openclaw models auth list` shows "Profiles: (none)". The
#      key must be INSTALLED into the auth store, not just referenced.
# `paste-api-key` installs the sk-... platform key as an api_key profile and
# points openai models at api.openai.com, where the key is valid. The docs' own
# automation form is `printf "%s\n" "$OPENAI_API_KEY" | ... paste-api-key`.
# Runs OUTSIDE the seed block so the credential survives a volume that predates
# this step, and BEFORE `openclaw gateway` starts below so the profile exists
# when the agent first resolves a model.
# Requires openclaw >= 2026.6.x (paste-api-key was added then; 2026.5.x has only
# paste-token) — pinned in deploy/fly/Dockerfile. A missing subcommand exits 1,
# so this step fails closed.
#
# The profile is named after a hash of the key, NOT the default openai:manual.
# OpenClaw records a billing failure ("no credits") against the PROFILE and
# disables it for 5-24 hours, and that record lives on the volume. Pasting a
# new key into the same profile replaces the key and keeps the lockout, so the
# new key is never tried: a funded replacement key keeps answering
# "billing error" until the lockout is cleared by hand. A new key now gets a
# new profile with no history, while the same key keeps its lockout, which is
# right: that account really is out of credits.
# `order set` pins the agent to this one profile, so profiles left behind by
# earlier keys are never tried.
if [ -n "${OPENAI_API_KEY:-}" ]; then
  OPENAI_PROFILE_ID="openai:key-$(printf '%s' "${OPENAI_API_KEY}" | sha256sum | cut -c1-12)"
  OPENAI_PROFILE_MARKER="${STATE_DIR}/.openai-auth-profile"
  if marker_matches "${OPENAI_PROFILE_MARKER}" "${OPENAI_PROFILE_ID}"; then
    echo "[entrypoint] OpenAI auth profile ${OPENAI_PROFILE_ID} already installed"
  else
    echo "[entrypoint] wiring OpenAI api_key auth profile ${OPENAI_PROFILE_ID} from OPENAI_API_KEY"
    rm -f "${OPENAI_PROFILE_MARKER}"
    if ! printf '%s\n' "${OPENAI_API_KEY}" \
      | openclaw models auth paste-api-key --provider openai --profile-id "${OPENAI_PROFILE_ID}" \
      || ! openclaw models auth order set --provider openai "${OPENAI_PROFILE_ID}"; then
      echo "[entrypoint] FATAL: could not install the OpenAI api_key auth profile." >&2
      echo "[entrypoint]        The agent would boot with no usable model credential" >&2
      echo "[entrypoint]        and 401 on every turn. Refusing to start." >&2
      exit 1
    fi
    printf '%s\n' "${OPENAI_PROFILE_ID}" > "${OPENAI_PROFILE_MARKER}"
  fi
else
  echo "[entrypoint] FATAL: OPENAI_API_KEY is not set — the agent has no model" >&2
  echo "[entrypoint]        credential and would 401 on every turn. Refusing to start." >&2
  exit 1
fi

# Ensure the agent's workspace instructions carry the Alter sign-in/connect
# guidance. OpenClaw loads TOOLS.md + AGENTS.md into the agent's context every
# turn; the model does NOT reliably read the alter-accounts skill on its own,
# so without this it hallucinates a "connect via the Alter wallet" web flow.
# Idempotent (marker-guarded) and only appends to files that already exist, so
# it never interferes with the gateway's first-run bootstrap on a fresh volume
# (bootstrap seeds them, a later boot appends this). Markdown only — it cannot
# break config validation, unlike a config key.
WORKSPACE_DIR="${STATE_DIR}/workspace"
if [ -f "${WORKSPACE_DIR}/TOOLS.md" ] && ! grep -qF 'alter-signin-guidance' "${WORKSPACE_DIR}/TOOLS.md"; then
  echo "[entrypoint] adding Alter sign-in guidance to TOOLS.md"
  cat >> "${WORKSPACE_DIR}/TOOLS.md" <<'ALTER_TOOLS_GUIDANCE_EOF'

<!-- alter-signin-guidance:v1 -->
## Alter — signing in and connecting accounts (READ THIS FIRST)

You sign users in and connect their provider accounts (Gmail, Google Calendar, Google Drive, Slack, GitHub, Linear, Notion, Calendly, LinkedIn, X) yourself, directly from this chat. This is core to your job. Never claim you cannot.

How it works: to do anything with a provider, just call the relevant tool (for example alter_gmail_search). If the user is not signed in, or has not connected that provider, the tool returns a one-time link such as: Click here: https://... — that link is the expected, SUCCESSFUL result, not an error. Relay it to the user verbatim and stop. Sign-in and connecting happen when the user opens that link, finishes in their browser, and messages you again. To connect proactively you can also tell the user to type /alter connect (a menu of one-click links) or /alter connect <provider>.

NEVER do any of these — they are wrong and forbidden:
- Claiming you cannot sign the user in or connect accounts from chat. You can — surface the link.
- Claiming the sign-in flow is broken or throwing an error. It is not; the link-bearing tool result is success.
- Telling the user to go to the Alter wallet, a dashboard, or any external web UI to log in or connect. Connections do NOT originate there.
- Asking the user for a wallet URL, or inventing URLs like app.alter.sh or app.alter.ai.

The Alter wallet is ONLY for approving write actions (HITL) and managing or revoking already-connected accounts. It is NOT where users log in or connect — you create connections by surfacing the link the tool returns.

See the alter-accounts skill for full detail.
<!-- /alter-signin-guidance -->
ALTER_TOOLS_GUIDANCE_EOF
fi
if [ -f "${WORKSPACE_DIR}/AGENTS.md" ] && ! grep -qF 'Alter accounts (hard rule)' "${WORKSPACE_DIR}/AGENTS.md"; then
  echo "[entrypoint] adding Alter hard-rule to AGENTS.md"
  cat >> "${WORKSPACE_DIR}/AGENTS.md" <<'ALTER_AGENTS_GUIDANCE_EOF'

## Alter accounts (hard rule)

You CAN sign users in and connect their accounts (Gmail, Calendar, Drive, Slack, GitHub, Linear, Notion, Calendly, LinkedIn, X) directly from chat. To do it, call the relevant alter_* tool; it returns a one-time "Click here: <link>" — relay that link verbatim; it is success, not an error. NEVER tell the user to use the Alter wallet, a dashboard, or a web UI to log in or connect (the wallet is only for approving writes and managing existing connections), never say sign-in is broken, and never invent wallet URLs. See the alter-accounts skill and TOOLS.md.
ALTER_AGENTS_GUIDANCE_EOF
fi

# Register/refresh the alter plugin against the openclaw plugin index.
# Skipped when this image's build of the plugin is already on the volume: the
# gateway loads installed plugins from /data without any help from here.
#
# --dangerously-force-unsafe-install is required because OpenClaw's
# install-time scanner flags `child_process` use, which our CLI
# (`openclaw alter login`, `db-rotate-key`, etc.) needs for interactive
# operator flows. We control this plugin and ship it from-source; the
# scanner is meant to catch hostile npm/clawhub plugins, not first-party
# operator tooling. Auditable in src/cli/index.ts.
#
# --force makes the install idempotent across deploys (overwrite the
# existing plugin record).
#
# /app/plugin-build-id is written by the Dockerfile. If it is missing (an image
# built some other way), hash the plugin's own files instead.
ALTER_PLUGIN_BUILD="$(cat /app/plugin-build-id 2>/dev/null || true)"
if [ -z "${ALTER_PLUGIN_BUILD}" ]; then
  ALTER_PLUGIN_BUILD="$(find /app/plugin/dist /app/plugin/openclaw.plugin.json /app/plugin/package.json -type f \
    | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-64)"
fi
ALTER_PLUGIN_MARKER="${STATE_DIR}/.alter-plugin-build"
if marker_matches "${ALTER_PLUGIN_MARKER}" "${ALTER_PLUGIN_BUILD}" \
  && [ -f "${STATE_DIR}/extensions/alter/dist/index.js" ]; then
  echo "[entrypoint] alter plugin already installed (build $(printf '%s' "${ALTER_PLUGIN_BUILD}" | cut -c1-12))"
else
  echo "[entrypoint] registering alter plugin"
  rm -f "${ALTER_PLUGIN_MARKER}"
  if ! openclaw plugins install /app/plugin --dangerously-force-unsafe-install --force; then
    echo "[entrypoint] FATAL: alter plugin failed to install — gateway will boot without it" >&2
    exit 1
  fi
  printf '%s\n' "${ALTER_PLUGIN_BUILD}" > "${ALTER_PLUGIN_MARKER}"
fi

# Chat channels. Each one turns on when its credentials are set as secrets, so
# the same image serves Slack, Discord, or both:
#
#   Slack    SLACK_BOT_TOKEN + SLACK_APP_TOKEN (Socket Mode)
#   Discord  DISCORD_BOT_TOKEN
#
# Every boot, for each channel: openclaw.json gets `enabled` set to whether its
# credentials are present (a Discord block with team defaults is added the
# first time a Discord token appears; an operator's edits to an existing block
# are kept), and an enabled channel's plugin is installed. The channel plugins
# read their tokens from those env vars, so no secret is written to the config.
#
# The rules, and the Discord team defaults, live in config-reconcile.cjs
# (tests/deploy-config-reconcile.test.ts covers them). Tighten Discord access
# with dmPolicy "allowlist" / guild allowlists per the OpenClaw Discord docs.
echo "[entrypoint] reconciling chat channels with their credentials"
node /app/config-reconcile.cjs channels "${CONFIG_PATH}" || {
  echo "[entrypoint] FATAL: could not reconcile chat channels in ${CONFIG_PATH}" >&2
  exit 1
}

# Install an enabled channel's OpenClaw plugin from npm, at the gateway's own
# version. @openclaw/<channel> is released in lockstep with openclaw. Unpinned,
# the install resolves npm's latest, finds it incompatible with this runtime,
# and falls back to the matching version, which costs a second registry
# round-trip on every boot and would silently change the plugin if a newer
# compatible release appeared. Skipped when that version is already on the
# volume.
OPENCLAW_VERSION="$(cat /app/openclaw-version 2>/dev/null || true)"
install_channel_plugin() {
  channel="$1"
  spec="@openclaw/${channel}${OPENCLAW_VERSION:+@${OPENCLAW_VERSION}}"
  marker="${STATE_DIR}/.${channel}-plugin-version"
  if [ -n "${OPENCLAW_VERSION}" ] \
    && marker_matches "${marker}" "${OPENCLAW_VERSION}" \
    && [ -n "$(find "${STATE_DIR}/npm" -maxdepth 6 -path "*/node_modules/@openclaw/${channel}/package.json" 2>/dev/null | head -n 1)" ]; then
    echo "[entrypoint] @openclaw/${channel} ${OPENCLAW_VERSION} already installed"
    return 0
  fi
  echo "[entrypoint] registering ${spec}"
  rm -f "${marker}"
  if ! openclaw plugins install "${spec}" --force; then
    echo "[entrypoint] FATAL: ${spec} failed to install — gateway would boot without ${channel}" >&2
    exit 1
  fi
  if [ -n "${OPENCLAW_VERSION}" ]; then
    printf '%s\n' "${OPENCLAW_VERSION}" > "${marker}"
  fi
}
for channel in $(node /app/config-reconcile.cjs enabled-channels); do
  install_channel_plugin "${channel}"
done

# OpenClaw refuses to start with a non-loopback bind (`lan`) unless
# gateway auth is configured. No external user ever talks to the
# gateway WS in this deployment — Slack/Discord reach the bot via
# their own transports, and the alter plugin's OAuth callback is
# plugin-level routing, not gateway-WS. We still need a token to
# satisfy the safety check, so generate one on first boot and persist
# it under /data so subsequent boots reuse the same value.
GATEWAY_TOKEN_PATH="${STATE_DIR}/.gateway-token"
if [ ! -s "${GATEWAY_TOKEN_PATH}" ]; then
  echo "[entrypoint] generating ${GATEWAY_TOKEN_PATH}"
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))" > "${GATEWAY_TOKEN_PATH}"
  chmod 600 "${GATEWAY_TOKEN_PATH}"
fi
OPENCLAW_GATEWAY_TOKEN="$(cat "${GATEWAY_TOKEN_PATH}")"
export OPENCLAW_GATEWAY_TOKEN

echo "[entrypoint] starting gateway"
exec openclaw gateway \
  --port "${OPENCLAW_GATEWAY_PORT:-3000}" \
  --bind lan \
  --auth token
