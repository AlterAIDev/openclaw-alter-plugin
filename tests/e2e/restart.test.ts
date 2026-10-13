// What survives a gateway restart: sign-ins and connections are stored
// encrypted in the workspace, so people don't have to sign in again.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeAlter, type FakeAlter } from "../../dev/fake-alter.mjs";
import { chatUser, eventually, linkIn, startPluginHost, type PluginHost } from "./plugin-host.js";

let alter: FakeAlter;
let host: PluginHost | undefined;
const alice = chatUser("discord", "2222");
const SEARCH = { q: "is:open" };

beforeAll(async () => {
  alter = await startFakeAlter();
});

afterAll(async () => {
  await host?.close({ removeWorkspace: true });
  await alter?.close();
});

describe("restarting the gateway", () => {
  it("keeps people signed in and connected", async () => {
    host = await startPluginHost({ alterUrl: alter.url });
    alter.signIn(linkIn((await host.command(alice, "login")).text).toString(), "alice");
    await eventually(async () => (await host!.command(alice, "status")).text.includes("Linked: yes"));
    const callback = alter.connect(linkIn((await host.command(alice, "connect github")).text).toString());
    expect((await fetch(callback)).status).toBe(200);
    expect((await host.callTool(alice, "alter_github_search_issues", SEARCH)).isError).toBe(false);

    const workspaceDir = host.workspaceDir;
    await host.close();
    host = await startPluginHost({ alterUrl: alter.url, workspaceDir });

    expect((await host.command(alice, "status")).text).toContain("Linked: yes");
    const before = alter.calls.length;
    const reply = await host.callTool(alice, "alter_github_search_issues", SEARCH);
    expect(reply.isError).toBe(false);
    expect(alter.calls.slice(before)).toEqual([expect.objectContaining({ sub: "alice" })]);
  });

  it("finishes a sign-in that was still open when the gateway restarted", async () => {
    const bob = chatUser("discord", "3333");
    const signInLink = linkIn((await host!.command(bob, "login")).text).toString();
    const workspaceDir = host!.workspaceDir;
    await host!.close();
    host = await startPluginHost({ alterUrl: alter.url, workspaceDir });
    expect(host.logs.map((l) => l.message)).toContain("[alter] resumed polling for 1 pending sign-in session(s)");

    // The old gateway's poll is still open at Alter and sees the sign-in
    // finish too, but it was stopped, so only the new gateway may store it.
    alter.signIn(signInLink, "bob");
    await eventually(async () => (await host!.command(bob, "status")).text.includes("Linked: yes"));
    expect(host.logs.some((l) => l.message.includes("sign-in inserted for (discord, <user>)"))).toBe(true);
  });

  it("refuses to use stored sign-ins under a different database key", async () => {
    const workspaceDir = host!.workspaceDir;
    await host!.close();
    host = await startPluginHost({
      alterUrl: alter.url,
      workspaceDir,
      secrets: { OPENCLAW_ALTER_DB_KEY: "ab".repeat(32) },
    });
    // A wrong key is an operator mistake: the sealed sign-in fails to decrypt
    // and the call fails loudly, rather than acting for anyone.
    const before = alter.requests.length;
    await expect(host.callTool(alice, "alter_github_search_issues", SEARCH)).rejects.toThrow(
      /unable to authenticate data/,
    );
    expect(alter.requests.length).toBe(before);
  });
});
