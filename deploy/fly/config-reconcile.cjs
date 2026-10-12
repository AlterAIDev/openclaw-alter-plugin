#!/usr/bin/env node
// Boot-time reconciliation of /data/openclaw.json for the Fly deployment.
// entrypoint.sh runs this on every boot; tests/deploy-config-reconcile.test.ts
// covers it. Plain CommonJS so the container runs it with bare `node`.
//
//   node config-reconcile.cjs tools <openclaw.json> <openclaw.plugin.json>
//   node config-reconcile.cjs channels <openclaw.json>
//   node config-reconcile.cjs enabled-channels
//
// Each subcommand writes the config only when something changed, so a
// steady-state boot leaves the file untouched.
"use strict";

const fs = require("node:fs");

// Chat channels the reference deployment can run, and the env vars that turn
// each one on. The channel plugins read their tokens from these same vars, so
// no secret is ever written to openclaw.json.
const CHANNELS = {
  slack: {
    credentials: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"],
    // openclaw.json.template ships the Slack block.
    defaults: null,
  },
  discord: {
    credentials: ["DISCORD_BOT_TOKEN"],
    // Team defaults, mirroring the template's Slack block: anyone who shares a
    // server with the bot can DM it or @mention it in a channel (OpenClaw
    // answers in server channels only when mentioned). Every Alter tool still
    // requires the person to sign in through the identity provider.
    defaults: { enabled: true, dmPolicy: "open", allowFrom: ["*"], groupPolicy: "open" },
  },
};

/** Names of the channels whose credentials are all set in `env`. */
function enabledChannels(env) {
  return Object.keys(CHANNELS).filter((name) =>
    CHANNELS[name].credentials.every((key) => Boolean(env[key])),
  );
}

/**
 * Set each channel's `enabled` to whether its credentials are present. A
 * channel with credentials but no config block gets its defaults (if it has
 * any); an existing block keeps every other key the operator set. An enabled
 * channel gets a binding to the main agent if it has none.
 */
function reconcileChannels(cfg, env) {
  const next = structuredClone(cfg);
  next.channels = next.channels || {};
  next.bindings = Array.isArray(next.bindings) ? next.bindings : [];
  const on = new Set(enabledChannels(env));
  let changed = false;
  for (const [name, spec] of Object.entries(CHANNELS)) {
    const enabled = on.has(name);
    const current = next.channels[name];
    if (!current) {
      if (enabled && spec.defaults) {
        next.channels[name] = structuredClone(spec.defaults);
        changed = true;
      }
    } else if (current.enabled !== enabled) {
      current.enabled = enabled;
      changed = true;
    }
    if (
      enabled &&
      next.channels[name] &&
      !next.bindings.some((b) => b && b.match && b.match.channel === name)
    ) {
      next.bindings.push({ agentId: "main", match: { channel: name } });
      changed = true;
    }
  }
  const summary = Object.keys(CHANNELS)
    .map((name) => `${name} ${on.has(name) ? "on" : "off"}`)
    .join(", ");
  return { cfg: next, changed, summary, enabled: [...on] };
}

/**
 * Make tools.alsoAllow list exactly the manifest's alter_* tools, keeping any
 * non-alter_* entry an operator added. Removing a tool from the manifest
 * removes it here too. An empty manifest leaves the config alone.
 */
function reconcileToolsAllow(cfg, manifestTools) {
  const want = Array.isArray(manifestTools) ? manifestTools : [];
  if (want.length === 0) {
    return { cfg, changed: false, skipped: true, want: 0, preserved: 0 };
  }
  const next = structuredClone(cfg);
  next.tools = next.tools || {};
  const existing = Array.isArray(next.tools.alsoAllow) ? next.tools.alsoAllow : [];
  const foreign = existing.filter((t) => typeof t === "string" && !t.startsWith("alter_"));
  const merged = [...foreign, ...want];
  const same = existing.length === merged.length && existing.every((t, i) => t === merged[i]);
  if (!same) next.tools.alsoAllow = merged;
  return { cfg: same ? cfg : next, changed: !same, skipped: false, want: want.length, preserved: foreign.length };
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function main(argv, env) {
  const [command, configPath, manifestPath] = argv;
  if (command === "enabled-channels") {
    process.stdout.write(enabledChannels(env).join("\n") + "\n");
    return 0;
  }
  if (command === "channels" && configPath) {
    const result = reconcileChannels(readJson(configPath), env);
    if (result.changed) writeJson(configPath, result.cfg);
    console.log(`[entrypoint] chat channels: ${result.summary}${result.changed ? " (config updated)" : ""}`);
    if (result.enabled.length === 0) {
      console.log("[entrypoint] no chat channel credentials set; only the Control UI will reach the agent");
    }
    return 0;
  }
  if (command === "tools" && configPath && manifestPath) {
    const manifest = readJson(manifestPath);
    const result = reconcileToolsAllow(readJson(configPath), manifest.contracts && manifest.contracts.tools);
    if (result.skipped) {
      console.error("[entrypoint] manifest declares no tools — leaving alsoAllow alone");
    } else if (result.changed) {
      writeJson(configPath, result.cfg);
      console.log(
        `[entrypoint] tools.alsoAllow updated: ${result.want} alter tools` +
          (result.preserved ? ` (+${result.preserved} preserved)` : ""),
      );
    } else {
      console.log(`[entrypoint] tools.alsoAllow already in sync (${result.want} alter tools)`);
    }
    return 0;
  }
  console.error(
    "usage: config-reconcile.cjs tools <openclaw.json> <openclaw.plugin.json> | channels <openclaw.json> | enabled-channels",
  );
  return 64;
}

module.exports = { CHANNELS, enabledChannels, reconcileChannels, reconcileToolsAllow, main };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
