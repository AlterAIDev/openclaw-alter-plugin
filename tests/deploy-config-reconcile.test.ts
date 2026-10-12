import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The Fly entrypoint's boot-time config reconciliation
 * (deploy/fly/config-reconcile.cjs): which chat channels run, and which tools
 * the agent can see. A mistake here doesn't fail loudly; it boots a gateway
 * that silently ignores Discord, or hides every alter_* tool from the model.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "deploy", "fly", "config-reconcile.cjs");
const require = createRequire(import.meta.url);

type Config = {
  channels?: Record<string, Record<string, unknown>>;
  bindings?: Array<{ agentId: string; match: { channel: string } }>;
  tools?: { alsoAllow?: unknown };
  [key: string]: unknown;
};
type ChannelResult = { cfg: Config; changed: boolean; summary: string; enabled: string[] };
type ToolsResult = { cfg: Config; changed: boolean; skipped: boolean; want: number; preserved: number };
const reconcile = require("../deploy/fly/config-reconcile.cjs") as {
  enabledChannels: (env: Record<string, string | undefined>) => string[];
  reconcileChannels: (cfg: Config, env: Record<string, string | undefined>) => ChannelResult;
  reconcileToolsAllow: (cfg: Config, manifestTools: unknown) => ToolsResult;
};

const SLACK = { SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-test" };
const DISCORD = { DISCORD_BOT_TOKEN: "discord-test-token" };

/** The shape openclaw.json.template seeds: a Slack block and a Slack binding. */
function seeded(): Config {
  return {
    bindings: [{ agentId: "main", match: { channel: "slack" } }],
    channels: {
      slack: { enabled: true, mode: "socket", dmPolicy: "open", allowFrom: ["*"], groupPolicy: "open" },
    },
    tools: { alsoAllow: ["alter_old_tool"] },
  };
}

describe("enabledChannels", () => {
  it("needs every credential a channel lists", () => {
    expect(reconcile.enabledChannels({})).toEqual([]);
    expect(reconcile.enabledChannels({ SLACK_BOT_TOKEN: "xoxb-test" })).toEqual([]);
    expect(reconcile.enabledChannels(SLACK)).toEqual(["slack"]);
    expect(reconcile.enabledChannels(DISCORD)).toEqual(["discord"]);
    expect(reconcile.enabledChannels({ ...SLACK, ...DISCORD })).toEqual(["slack", "discord"]);
  });

  it("treats an empty variable as unset", () => {
    expect(reconcile.enabledChannels({ DISCORD_BOT_TOKEN: "" })).toEqual([]);
  });
});

describe("reconcileChannels", () => {
  it("turns Slack off when its tokens are missing, without adding Discord", () => {
    const r = reconcile.reconcileChannels(seeded(), {});
    expect(r.cfg.channels?.slack?.enabled).toBe(false);
    expect(r.cfg.channels?.discord).toBeUndefined();
    expect(r.changed).toBe(true);
    expect(r.summary).toBe("slack off, discord off");
  });

  it("keeps Slack on, unchanged, when both of its tokens are set", () => {
    const r = reconcile.reconcileChannels(seeded(), SLACK);
    expect(r.changed).toBe(false);
    expect(r.cfg).toEqual(seeded());
    expect(r.summary).toBe("slack on, discord off");
  });

  it("adds a Discord block with the team defaults and a binding when the token appears", () => {
    const r = reconcile.reconcileChannels(seeded(), { ...SLACK, ...DISCORD });
    expect(r.cfg.channels?.discord).toEqual({
      enabled: true,
      dmPolicy: "open",
      allowFrom: ["*"],
      groupPolicy: "open",
    });
    expect(r.cfg.bindings).toContainEqual({ agentId: "main", match: { channel: "discord" } });
    expect(r.enabled).toEqual(["slack", "discord"]);
  });

  it("never writes the token into the config", () => {
    const r = reconcile.reconcileChannels(seeded(), DISCORD);
    expect(JSON.stringify(r.cfg)).not.toContain(DISCORD.DISCORD_BOT_TOKEN);
  });

  it("keeps an operator's edits to an existing Discord block, flipping only enabled", () => {
    const cfg = seeded();
    cfg.channels!.discord = {
      enabled: true,
      dmPolicy: "allowlist",
      allowFrom: ["discord:placeholder-user-id"],
      guilds: { "111": { requireMention: false } },
    };
    const off = reconcile.reconcileChannels(cfg, SLACK);
    expect(off.cfg.channels?.discord).toEqual({ ...cfg.channels!.discord, enabled: false });

    const on = reconcile.reconcileChannels(off.cfg, { ...SLACK, ...DISCORD });
    expect(on.cfg.channels?.discord).toEqual(cfg.channels!.discord);
  });

  it("does not add a second binding for a channel that already has one", () => {
    const first = reconcile.reconcileChannels(seeded(), { ...SLACK, ...DISCORD });
    const second = reconcile.reconcileChannels(first.cfg, { ...SLACK, ...DISCORD });
    expect(second.changed).toBe(false);
    expect(second.cfg.bindings?.filter((b) => b.match.channel === "discord")).toHaveLength(1);
  });

  it("leaves the input object untouched", () => {
    const cfg = seeded();
    const before = JSON.stringify(cfg);
    reconcile.reconcileChannels(cfg, DISCORD);
    expect(JSON.stringify(cfg)).toBe(before);
  });
});

describe("reconcileToolsAllow", () => {
  it("replaces alter_* entries with the manifest's tools and keeps the operator's own", () => {
    const cfg: Config = { tools: { alsoAllow: ["browser", "alter_removed", "alter_gmail_search"] } };
    const r = reconcile.reconcileToolsAllow(cfg, ["alter_gmail_search", "alter_gmail_send"]);
    expect(r.cfg.tools?.alsoAllow).toEqual(["browser", "alter_gmail_search", "alter_gmail_send"]);
    expect(r.changed).toBe(true);
    expect(r.preserved).toBe(1);
  });

  it("reports no change when already in sync", () => {
    const cfg: Config = { tools: { alsoAllow: ["alter_a", "alter_b"] } };
    const r = reconcile.reconcileToolsAllow(cfg, ["alter_a", "alter_b"]);
    expect(r.changed).toBe(false);
    expect(r.cfg).toBe(cfg);
  });

  it("leaves the config alone when the manifest declares no tools", () => {
    const cfg: Config = { tools: { alsoAllow: ["alter_a"] } };
    const r = reconcile.reconcileToolsAllow(cfg, []);
    expect(r.skipped).toBe(true);
    expect(r.cfg).toBe(cfg);
  });

  it("matches the real manifest's tool list", () => {
    const manifest = JSON.parse(readFileSync(join(HERE, "..", "openclaw.plugin.json"), "utf8"));
    const r = reconcile.reconcileToolsAllow({}, manifest.contracts.tools);
    expect(r.cfg.tools?.alsoAllow).toEqual(manifest.contracts.tools);
    expect(r.want).toBe(32);
  });
});

describe("the command-line entry point entrypoint.sh calls", () => {
  let dir: string;
  let configPath: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "alter-reconcile-"));
    configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, JSON.stringify(seeded(), null, 2) + "\n");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (args: string[], env: Record<string, string>) =>
    execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  it("channels: updates the file once, then leaves it untouched", () => {
    const first = run(["channels", configPath], DISCORD);
    expect(first).toContain("chat channels: slack off, discord on (config updated)");
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.channels.discord.enabled).toBe(true);
    expect(written.channels.slack.enabled).toBe(false);

    const mtime = statSync(configPath).mtimeMs;
    const second = run(["channels", configPath], DISCORD);
    expect(second).toContain("chat channels: slack off, discord on");
    expect(second).not.toContain("config updated");
    expect(statSync(configPath).mtimeMs).toBe(mtime);
  });

  it("channels: says so when no channel has credentials", () => {
    expect(run(["channels", configPath], {})).toContain("no chat channel credentials set");
  });

  it("enabled-channels: prints one channel per line for the install loop", () => {
    expect(run(["enabled-channels"], { ...SLACK, ...DISCORD }).trim().split("\n")).toEqual(["slack", "discord"]);
    expect(run(["enabled-channels"], {}).trim()).toBe("");
  });

  it("tools: syncs alsoAllow from the manifest file", () => {
    const manifestPath = join(dir, "openclaw.plugin.json");
    writeFileSync(manifestPath, JSON.stringify({ contracts: { tools: ["alter_x", "alter_y"] } }));
    expect(run(["tools", configPath, manifestPath], {})).toContain("tools.alsoAllow updated: 2 alter tools");
    expect(JSON.parse(readFileSync(configPath, "utf8")).tools.alsoAllow).toEqual(["alter_x", "alter_y"]);
    expect(run(["tools", configPath, manifestPath], {})).toContain("already in sync (2 alter tools)");
  });

  it("rejects an unknown command with a usage message", () => {
    expect(() => run(["bogus"], {})).toThrow(/usage: config-reconcile\.cjs/);
  });
});
