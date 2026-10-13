#!/usr/bin/env bash
#
# smoke-test.sh: build the Fly image and boot it in Docker once per chat-channel
# setup, with placeholder secrets, to check what a deploy depends on: the
# config is accepted, the right channel plugins install, the alter plugin
# registers, every tool is visible to the agent and refuses non-chat callers,
# the gateway starts listening, and a restart reinstalls nothing.
#
#   bash deploy/fly/smoke-test.sh [--image TAG] [--keep]
#
#   --image TAG  use an already-built image instead of building one
#   --keep       leave the containers and volumes behind for inspection
#
# It can't check a real Slack or Discord connection: the placeholder tokens
# make each channel log an auth failure, which is expected. Real connectivity
# is the post-deploy checklist in deploy/fly/README.md.
#
# Needs Docker and network access (boots install plugins from npm). Takes a
# few minutes. CI runs it on pull requests that touch the deployment.

set -euo pipefail

FLY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${FLY_DIR}/../.." && pwd)"
IMAGE=""
KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --image)
      IMAGE="${2:?--image needs a tag}"
      shift
      ;;
    --keep) KEEP=1 ;;
    -h | --help)
      awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *)
      echo "unknown argument: $1 (see --help)" >&2
      exit 64
      ;;
  esac
  shift
done

RUN_ID="smoke-$$"
CONTAINERS=()
VOLUMES=()
LOG_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "${LOG_DIR}"
  [ "${KEEP}" = 1 ] && return 0
  for c in "${CONTAINERS[@]+"${CONTAINERS[@]}"}"; do docker rm -f "${c}" > /dev/null 2>&1 || true; done
  for v in "${VOLUMES[@]+"${VOLUMES[@]}"}"; do docker volume rm -f "${v}" > /dev/null 2>&1 || true; done
}
trap cleanup EXIT

# Placeholders built at run time, so nothing here looks like a real secret to
# a scanner. Alter keys use the legacy format, which passes the SDK's syntax
# check; nothing ever reaches Alter.
rand() { LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$1" || true; }
hex() { LC_ALL=C tr -dc '0-9a-f' < /dev/urandom | head -c 64 || true; }
SECRETS=(
  -e FLY_APP_NAME=smoke-test
  -e "CHANNEL_HASH_SALT=$(hex)"
  -e "OPENAI_API_KEY=sk-$(rand 40)"
  -e "OPENCLAW_ALTER_AGENT_API_KEY=alter_key_$(rand 40)"
  -e "OPENCLAW_ALTER_APP_API_KEY=alter_key_$(rand 40)"
  -e "OPENCLAW_ALTER_STATE_HMAC_SECRET=$(hex)"
  -e "OPENCLAW_ALTER_DB_KEY=$(hex)"
)
SLACK=(-e "SLACK_BOT_TOKEN=xoxb-$(rand 24)" -e "SLACK_APP_TOKEN=xapp-$(rand 24)")
DISCORD_TOKEN="$(rand 24).$(rand 6).$(rand 38)"
DISCORD=(-e "DISCORD_BOT_TOKEN=${DISCORD_TOKEN}")

FAILS=0
pass() { printf '  ok    %s\n' "$1"; }
fail() {
  printf '  FAIL  %s\n' "$1"
  FAILS=$((FAILS + 1))
}

# boot <container> <volume> [docker -e args...]: start the image and wait until
# the gateway listens, the entrypoint gives up, or the container exits.
boot() {
  local name="$1" volume="$2"
  shift 2
  docker rm -f "${name}" > /dev/null 2>&1 || true
  docker run -d --name "${name}" -v "${volume}:/data" "${SECRETS[@]}" "$@" "${IMAGE}" > /dev/null
  CONTAINERS+=("${name}")
  local waited=0
  while [ "${waited}" -lt 420 ]; do
    capture "${name}"
    if grep -qE 'http server listening|\[entrypoint\] FATAL' "${LOG_DIR}/${name}.log"; then break; fi
    [ "$(docker inspect -f '{{.State.Running}}' "${name}")" = "true" ] || break
    sleep 3
    waited=$((waited + 3))
  done
  sleep 2 # let the lines right after "listening" land, then take the final copy
  capture "${name}"
}

# capture <container>: save its log to a file. Checks grep the file, never a
# `docker logs | grep -q` pipe: grep -q exits at the first match, docker logs
# gets SIGPIPE, and pipefail turns a match into a failure.
capture() {
  docker logs "$1" > "${LOG_DIR}/$1.log" 2>&1 || true
}

# expect <container> <description> <grep -E pattern> [absent]
expect() {
  local name="$1" what="$2" pattern="$3" mode="${4:-present}"
  if grep -qE "${pattern}" "${LOG_DIR}/${name}.log"; then
    [ "${mode}" = present ] && pass "${what}" || fail "${what}"
  else
    [ "${mode}" = present ] && fail "${what}" || pass "${what}"
  fi
}

# config_value <volume> <js expression on cfg>: evaluate against /data/openclaw.json.
config_value() {
  docker run --rm -v "$1:/data" --entrypoint node "${IMAGE}" \
    -e 'const cfg = require("/data/openclaw.json"); console.log(JSON.stringify(eval(process.argv[1])))' "$2"
}

# tool_check <container>: through the gateway's own /tools/invoke API, inside
# the container, check that every tool in the manifest is allowed for the agent
# and that an Alter tool refuses a caller that isn't a chat user. Prints
# "refuses=<bool> missing=<tools or none>".
tool_check() {
  docker exec "$1" node -e '
    const fs = require("fs");
    const token = fs.readFileSync("/data/.gateway-token", "utf8").trim();
    const tools = require("/app/plugin/openclaw.plugin.json").contracts.tools;
    const invoke = (tool) => fetch(`http://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || 3000}/tools/invoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args: {} }),
    });
    (async () => {
      const missing = [];
      for (const tool of tools) if ((await invoke(tool)).status === 404) missing.push(tool);
      const body = await (await invoke("alter_github_search_issues")).json();
      const refuses = body.ok === true && body.result.isError === true &&
        /channel-attached chat session/.test(body.result.content[0].text);
      console.log(`refuses=${refuses} missing=${missing.join(",") || "none"}`);
    })().catch((e) => { console.log(`refuses=false missing=error:${e.message}`); });
  ' 2>&1 || true
}

show_log_on_failure() {
  local before="$1" name="$2"
  if [ "${FAILS}" -gt "${before}" ]; then
    echo "  --- last 40 log lines of ${name} ---"
    { grep -vE '^\s+at ' "${LOG_DIR}/${name}.log" || true; } | tail -n 40 | sed 's/^/  | /'
  fi
}

if [ -z "${IMAGE}" ]; then
  IMAGE="openclaw-alter-smoke:${RUN_ID}"
  echo "==> Building ${IMAGE}"
  docker build -q -f "${PLUGIN_ROOT}/deploy/fly/Dockerfile" -t "${IMAGE}" "${PLUGIN_ROOT}" > /dev/null
fi
OPENCLAW_VERSION="$(docker run --rm --entrypoint cat "${IMAGE}" /app/openclaw-version)"
echo "==> OpenClaw ${OPENCLAW_VERSION}"

LISTENING='http server listening'
ALTER_UP='alter plugin registered'

echo "==> 1. No chat-channel secrets"
before="${FAILS}"
VOLUMES+=("${RUN_ID}-none")
boot "${RUN_ID}-none" "${RUN_ID}-none"
expect "${RUN_ID}-none" "gateway listening" "${LISTENING}"
expect "${RUN_ID}-none" "alter plugin registered" "${ALTER_UP}"
expect "${RUN_ID}-none" "both channels off" 'chat channels: slack off, discord off'
expect "${RUN_ID}-none" "no Slack plugin installed" 'registering @openclaw/slack' absent
expect "${RUN_ID}-none" "no Discord plugin installed" 'registering @openclaw/discord' absent
expect "${RUN_ID}-none" "no entrypoint failure" '\[entrypoint\] FATAL' absent
tools="$(tool_check "${RUN_ID}-none")"
case "${tools}" in
  *missing=none*) pass "every manifest tool is allowed for the agent" ;;
  *) fail "every manifest tool is allowed for the agent (${tools})" ;;
esac
case "${tools}" in
  *refuses=true*) pass "an Alter tool refuses a caller that isn't a chat user" ;;
  *) fail "an Alter tool refuses a caller that isn't a chat user (${tools})" ;;
esac
show_log_on_failure "${before}" "${RUN_ID}-none"

echo "==> 2. Slack secrets only"
before="${FAILS}"
VOLUMES+=("${RUN_ID}-slack")
boot "${RUN_ID}-slack" "${RUN_ID}-slack" "${SLACK[@]}"
expect "${RUN_ID}-slack" "gateway listening" "${LISTENING}"
expect "${RUN_ID}-slack" "alter plugin registered" "${ALTER_UP}"
expect "${RUN_ID}-slack" "Slack on, Discord off" 'chat channels: slack on, discord off'
expect "${RUN_ID}-slack" "Slack plugin installed at the gateway's version" "registering @openclaw/slack@${OPENCLAW_VERSION}"
expect "${RUN_ID}-slack" "Slack loaded by the gateway" "${LISTENING}.*slack"
expect "${RUN_ID}-slack" "no Discord plugin installed" 'registering @openclaw/discord' absent
expect "${RUN_ID}-slack" "no entrypoint failure" '\[entrypoint\] FATAL' absent
show_log_on_failure "${before}" "${RUN_ID}-slack"

echo "==> 3. Discord secret only"
before="${FAILS}"
VOLUMES+=("${RUN_ID}-discord")
boot "${RUN_ID}-discord" "${RUN_ID}-discord" "${DISCORD[@]}"
expect "${RUN_ID}-discord" "gateway listening" "${LISTENING}"
expect "${RUN_ID}-discord" "alter plugin registered" "${ALTER_UP}"
expect "${RUN_ID}-discord" "Discord on, Slack off" 'chat channels: slack off, discord on \(config updated\)'
expect "${RUN_ID}-discord" "Discord plugin installed at the gateway's version" "registering @openclaw/discord@${OPENCLAW_VERSION}"
expect "${RUN_ID}-discord" "Discord loaded by the gateway" "${LISTENING}.*discord"
expect "${RUN_ID}-discord" "no Slack plugin installed" 'registering @openclaw/slack' absent
expect "${RUN_ID}-discord" "no entrypoint failure" '\[entrypoint\] FATAL' absent
docker rm -f "${RUN_ID}-discord" > /dev/null
if [ "$(config_value "${RUN_ID}-discord" 'cfg.channels.discord.enabled && cfg.channels.discord.dmPolicy')" = '"open"' ]; then
  pass "config has Discord enabled with the team defaults"
else
  fail "config has Discord enabled with the team defaults"
fi
if docker run --rm -v "${RUN_ID}-discord:/data" --entrypoint grep "${IMAGE}" -qF "${DISCORD_TOKEN}" /data/openclaw.json; then
  fail "Discord token kept out of the config"
else
  pass "Discord token kept out of the config"
fi
show_log_on_failure "${before}" "${RUN_ID}-discord"

echo "==> 4. Restart with both (reuses the Discord volume)"
before="${FAILS}"
boot "${RUN_ID}-both" "${RUN_ID}-discord" "${SLACK[@]}" "${DISCORD[@]}"
expect "${RUN_ID}-both" "gateway listening" "${LISTENING}"
expect "${RUN_ID}-both" "alter plugin not reinstalled" 'alter plugin already installed'
expect "${RUN_ID}-both" "Discord plugin not reinstalled" "@openclaw/discord ${OPENCLAW_VERSION} already installed"
expect "${RUN_ID}-both" "Slack plugin installed" "registering @openclaw/slack@${OPENCLAW_VERSION}"
expect "${RUN_ID}-both" "both channels on" 'chat channels: slack on, discord on'
expect "${RUN_ID}-both" "no entrypoint failure" '\[entrypoint\] FATAL' absent
show_log_on_failure "${before}" "${RUN_ID}-both"

echo
if [ "${FAILS}" -gt 0 ]; then
  echo "smoke-test: ${FAILS} check(s) failed"
  exit 1
fi
echo "smoke-test: all checks passed"
