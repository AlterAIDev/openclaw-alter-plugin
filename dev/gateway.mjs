#!/usr/bin/env node
// Run a real OpenClaw gateway with this plugin on your machine, in a few
// seconds, with no accounts needed:
//
//   pnpm dev                 # build, then start the gateway on http://127.0.0.1:18789
//   pnpm dev -- --fresh      # forget everything from earlier runs first
//   pnpm dev -- --smoke      # start, check the plugin works, stop (CI runs this)
//
// --smoke runs in a throwaway state dir with the fake Alter and no chat
// channels: it ignores .env.dev and never touches .dev/.
//
// The gateway is the `openclaw` this repo already depends on, with its own
// state under .dev/ (your ~/.openclaw is never touched) and the plugin linked
// from this checkout, so a rebuild plus a restart picks up code changes.
//
// Alter: unless .env.dev holds real Alter keys, the plugin talks to
// dev/fake-alter.mjs, a local stand-in that signs you in, connects accounts
// and approves actions from pages on http://127.0.0.1:8787.
//
// Chat: the Control UI is the operator's console, so Alter tools (which act
// for a chat user) refuse there by design. To chat as a user, put Slack or
// Discord bot tokens and an OPENAI_API_KEY in .env.dev; see .env.dev.example.
// To exercise the user flows with no accounts at all, run `pnpm test:e2e`.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeApiKey, startFakeAlter } from "./fake-alter.mjs";

const require = createRequire(import.meta.url);
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
// openclaw's package exports cover neither its CLI nor package.json, so go by path.
const OPENCLAW_DIR = join(PLUGIN_DIR, "node_modules", "openclaw");
const OPENCLAW = join(OPENCLAW_DIR, "openclaw.mjs");
if (!existsSync(OPENCLAW)) {
  console.error("[dev] openclaw isn't installed; run `pnpm install` in openclaw-alter-plugin first");
  process.exit(1);
}
const OPENCLAW_VERSION = JSON.parse(readFileSync(join(OPENCLAW_DIR, "package.json"), "utf8")).version;
const reconcile = require("../deploy/fly/config-reconcile.cjs");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
if (flag("-h") || flag("--help")) {
  const header = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
  console.log(header.slice(0, header.findIndex((l) => !l.startsWith("//"))).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(0);
}
const PORT = Number(option("--port", "18789"));
const FAKE_ALTER_PORT = Number(option("--alter-port", "8787"));
const SMOKE = flag("--smoke");
const GATEWAY_URL = `http://127.0.0.1:${PORT}`;
// A smoke run must not wipe a developer's sign-ins or pick up their bot tokens.
const STATE_DIR = SMOKE ? mkdtempSync(join(tmpdir(), "openclaw-dev-smoke-")) : join(PLUGIN_DIR, ".dev");
/** Settings from .env.dev or the shell that would connect a smoke run to something real. */
const REAL_SERVICE_ENV = [
  "OPENAI_API_KEY",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "DISCORD_BOT_TOKEN",
  "OPENCLAW_ALTER_AGENT_API_KEY",
  "OPENCLAW_ALTER_APP_API_KEY",
  "ALTER_BASE_URL",
];

const say = (line = "") => console.log(line ? `[dev] ${line}` : "");

/** KEY=VALUE lines from .env.dev, if it exists. Values never override the real environment. */
function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    env[key] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}

/** Secrets this dev gateway generates once and keeps, so a restart keeps everyone signed in. */
function devSecrets() {
  const path = join(STATE_DIR, "secrets.json");
  const hex = (n) => randomBytes(n).toString("hex");
  const stored = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  const secrets = {
    OPENCLAW_GATEWAY_TOKEN: stored.OPENCLAW_GATEWAY_TOKEN ?? hex(24),
    CHANNEL_HASH_SALT: stored.CHANNEL_HASH_SALT ?? hex(16),
    OPENCLAW_ALTER_STATE_HMAC_SECRET: stored.OPENCLAW_ALTER_STATE_HMAC_SECRET ?? hex(32),
    OPENCLAW_ALTER_DB_KEY: stored.OPENCLAW_ALTER_DB_KEY ?? hex(32),
    // Only used with the fake Alter, which tells an agent key (alter_ak_) from
    // an app key (alter_rk_). Older .dev/ dirs hold alter_key_ ones; replace them.
    FAKE_AGENT_API_KEY: stored.FAKE_AGENT_API_KEY?.startsWith("alter_ak_") ? stored.FAKE_AGENT_API_KEY : fakeApiKey("agent"),
    FAKE_APP_API_KEY: stored.FAKE_APP_API_KEY?.startsWith("alter_rk_") ? stored.FAKE_APP_API_KEY : fakeApiKey("app"),
  };
  if (JSON.stringify(secrets) !== JSON.stringify(stored)) {
    writeFileSync(path, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
  }
  return secrets;
}

function run(cmd, cmdArgs, env, { quiet = false } = {}) {
  const result = spawnSync(cmd, cmdArgs, { cwd: PLUGIN_DIR, env, encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${[cmd, ...cmdArgs].join(" ")} exited ${result.status}`);
  }
  if (!quiet) process.stdout.write(result.stdout ?? "");
  return result.stdout ?? "";
}

const openclaw = (cmdArgs, env, opts) => run(process.execPath, [OPENCLAW, ...cmdArgs], env, opts);

/** Write .dev/openclaw.json from the deployment template, the first time only. */
function seedConfig(configPath, secrets) {
  if (existsSync(configPath)) return false;
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "openclaw.plugin.json"), "utf8"));
  const template = readFileSync(join(PLUGIN_DIR, "deploy/fly/openclaw.json.template"), "utf8")
    .replaceAll("__PUBLIC_BASE_URL__", GATEWAY_URL)
    .replaceAll("__CHANNEL_HASH_SALT__", secrets.CHANNEL_HASH_SALT)
    .replaceAll('"__ALTER_TOOLS_ALLOW__"', JSON.stringify(manifest.contracts?.tools ?? []));
  const cfg = JSON.parse(template);
  cfg.agents.defaults.workspace = join(STATE_DIR, "workspace");
  cfg.gateway.controlUi.allowedOrigins = [GATEWAY_URL, `http://localhost:${PORT}`];
  // Don't advertise a developer's laptop on the local network.
  cfg.plugins.entries.bonjour = { enabled: false };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
  return true;
}

/** Run `step` unless `.dev/<name>` already holds `value`. */
function once(name, value, step) {
  const marker = join(STATE_DIR, `.${name}`);
  if (existsSync(marker) && readFileSync(marker, "utf8") === value) return false;
  step();
  writeFileSync(marker, value);
  return true;
}

async function main() {
  if (flag("--fresh")) rmSync(STATE_DIR, { recursive: true, force: true });
  mkdirSync(join(STATE_DIR, "workspace"), { recursive: true });

  const fileEnv = SMOKE ? {} : readEnvFile(join(PLUGIN_DIR, ".env.dev"));
  const env = { ...fileEnv, ...process.env };
  if (SMOKE) for (const name of REAL_SERVICE_ENV) delete env[name];
  const secrets = devSecrets();
  const realAlter = Boolean(env.OPENCLAW_ALTER_AGENT_API_KEY && env.OPENCLAW_ALTER_APP_API_KEY);

  let fakeAlter;
  if (!realAlter) {
    fakeAlter = await startFakeAlter({ port: FAKE_ALTER_PORT, quiet: SMOKE });
    env.ALTER_BASE_URL = fakeAlter.url;
    env.OPENCLAW_ALTER_AGENT_API_KEY = secrets.FAKE_AGENT_API_KEY;
    env.OPENCLAW_ALTER_APP_API_KEY = secrets.FAKE_APP_API_KEY;
  }
  Object.assign(env, {
    OPENCLAW_STATE_DIR: STATE_DIR,
    OPENCLAW_GATEWAY_TOKEN: secrets.OPENCLAW_GATEWAY_TOKEN,
    OPENCLAW_ALTER_STATE_HMAC_SECRET: env.OPENCLAW_ALTER_STATE_HMAC_SECRET ?? secrets.OPENCLAW_ALTER_STATE_HMAC_SECRET,
    OPENCLAW_ALTER_DB_KEY: env.OPENCLAW_ALTER_DB_KEY ?? secrets.OPENCLAW_ALTER_DB_KEY,
  });

  say("building the plugin");
  run(process.execPath, [require.resolve("typescript/bin/tsc", { paths: [PLUGIN_DIR] }), "-p", "tsconfig.json"], env);

  const configPath = join(STATE_DIR, "openclaw.json");
  if (seedConfig(configPath, secrets)) say(`wrote ${configPath}`);
  const cfg = JSON.parse(readFileSync(configPath, "utf8"));
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "openclaw.plugin.json"), "utf8"));
  const tools = reconcile.reconcileToolsAllow(cfg, manifest.contracts?.tools);
  const channels = reconcile.reconcileChannels(tools.cfg, env);
  // The wallet link follows this run's Alter: the fake's pages, or the plugin's default.
  const alterCfg = channels.cfg.plugins.entries.alter.config;
  const walletChanged = alterCfg.walletBaseUrl !== fakeAlter?.url;
  if (fakeAlter) alterCfg.walletBaseUrl = fakeAlter.url;
  else delete alterCfg.walletBaseUrl;
  if (tools.changed || channels.changed || walletChanged) writeFileSync(configPath, JSON.stringify(channels.cfg, null, 2) + "\n");

  if (once("alter-plugin-link", PLUGIN_DIR, () => openclaw(["plugins", "install", "-l", PLUGIN_DIR], env, { quiet: true }))) {
    say("linked the plugin from this checkout");
  }
  for (const channel of channels.enabled) {
    if (once(`${channel}-plugin`, OPENCLAW_VERSION, () => {
      say(`installing @openclaw/${channel}@${OPENCLAW_VERSION} (needs network, first run only)`);
      openclaw(["plugins", "install", `@openclaw/${channel}@${OPENCLAW_VERSION}`, "--force"], env, { quiet: true });
    })) say(`${channel} plugin installed`);
  }
  if (env.OPENAI_API_KEY) {
    // Named after a fingerprint of the key, like the Fly entrypoint: a new key
    // gets a fresh profile instead of inheriting an old key's billing lockout.
    const profile = `openai:key-${hashOf(env.OPENAI_API_KEY)}`;
    once("openai-profile", profile, () => {
      const paste = spawnSync(
        process.execPath,
        [OPENCLAW, "models", "auth", "paste-api-key", "--provider", "openai", "--profile-id", profile],
        { cwd: PLUGIN_DIR, env, input: `${env.OPENAI_API_KEY}\n`, encoding: "utf8" },
      );
      if (paste.status !== 0) throw new Error(`could not install the OpenAI key: ${paste.stderr}`);
      openclaw(["models", "auth", "order", "set", "--provider", "openai", profile], env, { quiet: true });
      say("installed the OpenAI key");
    });
  }

  say(`starting OpenClaw ${OPENCLAW_VERSION}`);
  const gateway = spawn(process.execPath, [OPENCLAW, "gateway", "--port", String(PORT), "--bind", "loopback"], {
    cwd: PLUGIN_DIR,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      const text = chunk.toString();
      log += text;
      if (!SMOKE) process.stdout.write(text);
      if (log.includes("http server listening")) resolve();
    };
    gateway.stdout.on("data", onData);
    gateway.stderr.on("data", onData);
    gateway.on("exit", (code) => reject(new Error(`gateway exited (${code}) before it was ready`)));
    setTimeout(() => reject(new Error("gateway not ready after 60s")), 60_000).unref();
  });

  const exited = new Promise((resolve) => gateway.once("exit", resolve));
  let stopping = false;
  const stop = async () => {
    stopping = true;
    if (gateway.exitCode === null && gateway.signalCode === null) {
      gateway.kill("SIGTERM");
      const forced = setTimeout(() => gateway.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(forced);
    }
    await fakeAlter?.close();
    // Only once the gateway is gone: it writes to its state dir while it shuts down.
    if (SMOKE) rmSync(STATE_DIR, { recursive: true, force: true });
  };
  process.on("SIGINT", () => void stop().then(() => process.exit(130)));
  process.on("SIGTERM", () => void stop().then(() => process.exit(143)));

  try {
    await ready;
  } catch (e) {
    if (SMOKE) process.stdout.write(log);
    await stop();
    throw e;
  }
  // From here on the gateway exiting by itself is a crash: say so and stop the
  // fake too, instead of leaving `pnpm dev` running with nothing behind it.
  gateway.on("exit", (code, signal) => {
    if (stopping) return;
    console.error(`[dev] the gateway exited (${signal ?? `code ${code}`}); stopping`);
    void stop().then(() => process.exit(1));
  });

  if (SMOKE) {
    const failures = await smokeChecks(log, secrets, fakeAlter);
    await stop();
    if (failures > 0) {
      process.stdout.write(log);
      throw new Error(`dev smoke: ${failures} check(s) failed`);
    }
    say("dev smoke: all checks passed");
    return;
  }

  say();
  say(`Control UI   ${GATEWAY_URL}/#token=${secrets.OPENCLAW_GATEWAY_TOKEN}`);
  // Nothing read from the environment is echoed here, only where it came from.
  const alterLabel = realAlter
    ? env.ALTER_BASE_URL
      ? "the backend in ALTER_BASE_URL (.env.dev or the environment)"
      : "https://backend.alterauth.com"
    : `${fakeAlter.url} (fake: sign-in, connect and approval pages)`;
  say(`Alter        ${alterLabel}`);
  say(`Chat         ${channels.enabled.length ? channels.enabled.join(", ") : "none (add Slack or Discord tokens to .env.dev to chat as a user)"}`);
  say(`Model        ${env.OPENAI_API_KEY ? "OpenAI key installed" : "none (add OPENAI_API_KEY to .env.dev to chat)"}`);
  say(`State        ${STATE_DIR} (pnpm dev -- --fresh to start over)`);
  say("Ctrl-C stops everything.");
}

/** A short, stable fingerprint of a secret, to name things after it. scrypt rather than a bare hash: the input is a credential. */
function hashOf(value) {
  return scryptSync(value, "openclaw-dev-profile", 6).toString("hex");
}

/** What `--smoke` checks against the running gateway. Returns the number of failures. */
async function smokeChecks(log, secrets, fakeAlter) {
  let failures = 0;
  const check = (ok, what) => {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${what}`);
    if (!ok) failures += 1;
  };
  const manifest = JSON.parse(readFileSync(join(PLUGIN_DIR, "openclaw.plugin.json"), "utf8"));
  const toolCount = manifest.contracts.tools.length;
  check(/alter plugin registered \(.*\d+ tools \+ \d+ memory tools\)/.test(log), "alter plugin registered");
  check(/http server listening \(\d+ plugins: [^)]*\balter\b/.test(log), "gateway loaded the alter plugin");

  const invoke = await fetch(`${GATEWAY_URL}/tools/invoke`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secrets.OPENCLAW_GATEWAY_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ tool: "alter_github_search_issues", args: { q: "is:open" } }),
  }).then((r) => r.json());
  check(invoke.ok === true && invoke.result?.isError === true && /channel-attached chat session/.test(invoke.result.content?.[0]?.text ?? ""),
    "an Alter tool is reachable and refuses a caller that isn't a chat user");

  const missing = [];
  for (const tool of manifest.contracts.tools) {
    const r = await fetch(`${GATEWAY_URL}/tools/invoke`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secrets.OPENCLAW_GATEWAY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args: {} }),
    });
    if (r.status === 404) missing.push(tool);
  }
  check(missing.length === 0, `all ${toolCount} manifest tools are allowed for the agent${missing.length ? ` (missing: ${missing.join(", ")})` : ""}`);

  const callback = await fetch(`${GATEWAY_URL}/alter/connect/cb?state=forged`);
  check(callback.status === 400, "connect callback route rejects a forged state");
  if (fakeAlter) {
    const health = await fetch(`${fakeAlter.url}/fake/health`).then((r) => r.ok, () => false);
    check(health, "fake Alter is up");
  }
  return failures;
}

main().catch((e) => {
  console.error(`[dev] ${e instanceof Error ? e.message : String(e)}`);
  if (SMOKE) rmSync(STATE_DIR, { recursive: true, force: true });
  process.exit(1);
});
