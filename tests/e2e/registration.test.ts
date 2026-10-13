// What the plugin registers with the gateway at boot, checked against the
// manifest OpenClaw reads before loading it.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeAlter, type FakeAlter } from "../../dev/fake-alter.mjs";
import { startPluginHost, type PluginHost } from "./plugin-host.js";

const manifest = JSON.parse(readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8")) as {
  contracts: { tools: string[] };
};

let alter: FakeAlter;
let host: PluginHost;

beforeAll(async () => {
  alter = await startFakeAlter();
  host = await startPluginHost({ alterUrl: alter.url });
});

afterAll(async () => {
  await host?.close({ removeWorkspace: true });
  await alter?.close();
});

describe("plugin registration", () => {
  it("registers exactly the tools the manifest declares", () => {
    expect([...host.toolNames].sort()).toEqual([...manifest.contracts.tools].sort());
  });

  it("registers the /alter command, the connect callback, the usage and shutdown hooks and the operator CLI", () => {
    expect(host.commandNames).toEqual(["alter"]);
    expect(host.routePaths).toEqual(["/alter/connect/cb"]);
    expect([...host.hookNames].sort()).toEqual(["llm_output", "session_end"]);
    expect(host.lifecycleHookNames).toEqual(["gateway_stop"]);
    expect(host.cliRegistered).toBe(true);
  });

  it("boots without calling Alter", () => {
    expect(alter.requests).toEqual([]);
    expect(host.logs.filter((l) => l.level === "error" || l.level === "warn")).toEqual([]);
    expect(host.logs.map((l) => l.message)).toContainEqual(
      expect.stringMatching(/^alter plugin registered \(Alter-hosted sign-in flow, \d+ tools \+ \d+ memory tools\)$/),
    );
  });

  it.each([
    ["no chat context at all", { channel: "", senderId: "", sessionId: "" }],
    ["no channel", { channel: "", senderId: "U-ALICE", sessionId: "agent:main:slack:direct:U-ALICE" }],
    ["no sender", { channel: "slack", senderId: "", sessionId: "agent:main:slack:direct:U-ALICE" }],
    ["no session", { channel: "slack", senderId: "U-ALICE", sessionId: "" }],
  ])("refuses every tool call with %s", async (_, caller) => {
    for (const name of host.toolNames) {
      const reply = await host.callTool(caller, name, {});
      expect(reply.isError, name).toBe(true);
      expect(reply.text, name).toContain("requires a channel-attached chat session");
    }
    expect(alter.requests).toEqual([]);
  });
});

describe("startup checks", () => {
  it("won't start without its secrets", async () => {
    await expect(
      startPluginHost({ alterUrl: alter.url, secrets: { OPENCLAW_ALTER_DB_KEY: "too-short" } }),
    ).rejects.toThrow(/OPENCLAW_ALTER_DB_KEY/);
  });

  it("won't start with a public http:// callback URL", async () => {
    await expect(
      startPluginHost({ alterUrl: alter.url, pluginConfig: { publicBaseUrl: "http://gateway.example" } }),
    ).rejects.toThrow(/must use https/);
  });

  it("starts normally after a host that failed with its own secrets", async () => {
    const next = await startPluginHost({ alterUrl: alter.url });
    try {
      expect(next.toolNames.length).toBeGreaterThan(0);
    } finally {
      await next.close({ removeWorkspace: true });
    }
  });
});
