// Several people sharing one gateway: each acts only as themselves, whether
// they DM the bot or share a channel with it. Alter doesn't check that a
// proxied grant belongs to the user token sent with it (the plugin relies on
// user-scoped grant lists for that), and neither does the fake: it records
// both on every call, and these tests assert they match.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeAlter, type FakeAlter } from "../../dev/fake-alter.mjs";
import { chatUser, eventually, linkIn, startPluginHost, type ChatUser, type PluginHost } from "./plugin-host.js";

let alter: FakeAlter;
let host: PluginHost;
const SEARCH = { q: "is:open" };

const alice = chatUser("slack", "U-ALICE");
const bob = chatUser("slack", "U-BOB");
/** Alice again, but on Discord: a different chat account. */
const aliceOnDiscord = chatUser("discord", "1111");
/** One Slack channel both of them talk in: a single OpenClaw session. */
const channelSession = "agent:main:slack:channel:C-GENERAL";
const inChannel = (u: ChatUser): ChatUser => ({ ...u, sessionId: channelSession });

beforeAll(async () => {
  alter = await startFakeAlter();
  host = await startPluginHost({ alterUrl: alter.url });
});

afterAll(async () => {
  await host?.close({ removeWorkspace: true });
  await alter?.close();
});

async function signIn(user: ChatUser, name: string) {
  alter.signIn(linkIn((await host.command(user, "login")).text).toString(), name);
  await eventually(async () => (await host.command(user, "status")).text.includes("Linked: yes"));
}

async function connectGithub(user: ChatUser) {
  const callback = alter.connect(linkIn((await host.command(user, "connect github")).text).toString());
  expect((await fetch(callback)).status).toBe(200);
}

describe("people sharing a gateway", () => {
  beforeAll(async () => {
    await signIn(alice, "alice");
    await connectGithub(alice);
  });

  it("doesn't let a second person ride on the first person's sign-in", async () => {
    const reply = await host.callTool(bob, "alter_github_search_issues", SEARCH);
    expect(reply.text).toMatch(/sign in/i);
    expect((await host.command(bob, "status")).text).toContain("Linked: no");
    expect(alter.calls).toHaveLength(0);
  });

  it("makes each person connect their own account", async () => {
    await signIn(bob, "bob");
    const reply = await host.callTool(bob, "alter_github_search_issues", SEARCH);
    expect(reply.text).toMatch(/haven't connected GitHub/);
    expect(alter.calls).toHaveLength(0);
  });

  it("sends every call with the caller's own grant and token", async () => {
    await connectGithub(bob);
    await host.callTool(alice, "alter_github_search_issues", SEARCH);
    await host.callTool(bob, "alter_github_search_issues", SEARCH);
    const [aliceGrant] = alter.grantsOf("alice");
    const [bobGrant] = alter.grantsOf("bob");
    expect(alter.calls.map((c) => [c.sub, c.owner, c.grantId])).toEqual([
      ["alice", "alice", aliceGrant!.delegationId],
      ["bob", "bob", bobGrant!.delegationId],
    ]);
  });

  it("lists only your own connections", async () => {
    const aliceList = (await host.command(alice, "connections")).text;
    const bobList = (await host.command(bob, "connections")).text;
    expect(aliceList).toContain(alter.grantsOf("alice")[0]!.grantId);
    expect(aliceList).not.toContain(alter.grantsOf("bob")[0]!.grantId);
    expect(bobList).not.toContain(alter.grantsOf("alice")[0]!.grantId);
  });

  it("keeps each person's memories to themselves", async () => {
    expect((await host.callTool(alice, "alter_memory_remember", { content: "Alice prefers morning meetings" })).isError).toBe(false);
    const bobRecall = await host.callTool(bob, "alter_memory_recall", {});
    expect(bobRecall.text).not.toContain("morning meetings");
    const aliceRecall = await host.callTool(alice, "alter_memory_recall", {});
    expect(aliceRecall.text).toContain("Alice prefers morning meetings");
  });
});

describe("a shared channel", () => {
  it("acts as whoever sent the message, even though the channel is one session", async () => {
    const before = alter.calls.length;
    await host.callTool(inChannel(bob), "alter_github_search_issues", SEARCH);
    await host.callTool(inChannel(alice), "alter_github_search_issues", SEARCH);
    expect(alter.calls.slice(before).map((c) => c.sub)).toEqual(["bob", "alice"]);
  });

  it("doesn't let one person's pending approval block, or leak to, another", async () => {
    const aliceWrite = await host.callTool(inChannel(alice), "alter_github_create_issue", {
      owner: "acme",
      repo: "app",
      title: "From Alice",
    });
    const aliceApproval = linkIn(aliceWrite.text).toString();

    const bobWrite = await host.callTool(inChannel(bob), "alter_github_create_issue", {
      owner: "acme",
      repo: "app",
      title: "From Bob",
    });
    expect(bobWrite.text).toMatch(/Awaiting your approval at/);
    expect(bobWrite.text).not.toContain(aliceApproval);

    // Once Bob's action is approved, his next call reports it done, while
    // Alice, in the same channel, is still shown her own pending approval.
    alter.decide(linkIn(bobWrite.text).toString(), "approved");
    const bobNext = await host.callTool(inChannel(bob), "alter_github_create_issue", {
      owner: "acme",
      repo: "app",
      title: "From Bob",
    });
    expect(bobNext.text).toMatch(/approved and already completed/);
    const aliceNext = await host.callTool(inChannel(alice), "alter_github_create_issue", {
      owner: "acme",
      repo: "app",
      title: "From Alice",
    });
    expect(aliceNext.text).toContain(aliceApproval);
    expect((await host.command(inChannel(alice), "status")).text).toMatch(/Pending approval: (?!none)/);
  });
});

describe("the same person on another chat platform", () => {
  it("signs in separately, then finds the accounts they already connected", async () => {
    const first = await host.callTool(aliceOnDiscord, "alter_github_search_issues", SEARCH);
    expect(first.text).toMatch(/sign in/i);

    alter.signIn(linkIn(first.text).toString(), "alice");
    await eventually(async () => (await host.command(aliceOnDiscord, "status")).text.includes("Linked: yes"));

    const before = alter.calls.length;
    const reply = await host.callTool(aliceOnDiscord, "alter_github_search_issues", SEARCH);
    expect(reply.isError).toBe(false);
    expect(alter.calls.slice(before)).toEqual([
      expect.objectContaining({ sub: "alice", owner: "alice", grantId: alter.grantsOf("alice")[0]!.delegationId }),
    ]);
  });
});

describe("across everything above", () => {
  it("never ran a call on someone else's account", () => {
    expect(alter.calls.length).toBeGreaterThan(0);
    expect(alter.calls.filter((c) => c.owner !== c.sub)).toEqual([]);
  });
});
