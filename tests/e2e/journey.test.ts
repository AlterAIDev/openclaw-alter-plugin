// End to end: the real plugin and the real Alter SDK against the fake Alter
// backend (dev/fake-alter.mjs), over real HTTP. Each test is a step a person
// takes in chat; they run in order and build on each other, like one
// conversation.
//
// The plugin rate-limits its connect callback per IP (10 requests, refilling
// 1/s), and every request here comes from 127.0.0.1 within a second or so.
// This file makes 8 callback requests; keep it under 10 or split the file.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeAlter, type FakeAlter } from "../../dev/fake-alter.mjs";
import { chatUser, eventually, linkIn, startPluginHost, type PluginHost } from "./plugin-host.js";

let alter: FakeAlter;
let host: PluginHost;
const alice = chatUser("slack", "U-ALICE");
const SEARCH = { q: "repo:acme/app is:open" };
const NEW_ISSUE = { owner: "acme", repo: "app", title: "Login button is broken" };

beforeAll(async () => {
  alter = await startFakeAlter();
  host = await startPluginHost({ alterUrl: alter.url });
});

afterAll(async () => {
  await host?.close({ removeWorkspace: true });
  await alter?.close();
});

/** Follow the connect link in `reply`, approve it at the "provider", and land on the plugin's callback. */
async function connectFrom(reply: string) {
  const callback = alter.connect(linkIn(reply).toString());
  return fetch(callback);
}

/** How many times the plugin has called Alter's proxy so far. */
const proxyRequests = () => alter.requests.filter((r) => r.path === "/sdk/proxy").length;

/** How many sign-ins the plugin has stored for a user who was already linked. */
const refreshedSignIns = () => host.logs.filter((l) => l.message.includes("sign-in refreshed for (slack, <user>)")).length;

describe("signing in", () => {
  it("asks a new user to sign in before any tool runs, and calls nothing at Alter", async () => {
    const reply = await host.callTool(alice, "alter_github_search_issues", SEARCH);
    expect(reply.isError).toBe(false);
    expect(reply.text).toMatch(/sign in/i);
    expect(linkIn(reply.text).toString()).toMatch(/\/fake\/sign-in\/st_/);
    expect(alter.calls).toHaveLength(0);
    expect((await host.command(alice, "status")).text).toContain("Linked: no");
  });

  it("links the chat user once they finish signing in in the browser", async () => {
    const reply = await host.callTool(alice, "alter_github_search_issues", SEARCH);
    // The sign-in page itself, the way a browser uses it.
    const signInUrl = linkIn(reply.text).toString();
    expect(await (await fetch(signInUrl)).text()).toContain("Sign in as");
    const done = await fetch(signInUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "name=alice",
    });
    expect(await done.text()).toContain("Signed in as <b>alice</b>");
    await eventually(async () => (await host.command(alice, "status")).text.includes("Linked: yes"));
    expect(host.logs.some((l) => l.message.includes("sign-in inserted for (slack, <user>)"))).toBe(true);
  });
});

describe("connecting a provider", () => {
  it("asks to connect GitHub before the first GitHub call, and calls nothing", async () => {
    const reply = await host.callTool(alice, "alter_github_search_issues", SEARCH);
    expect(reply.text).toMatch(/haven't connected GitHub/);
    expect(linkIn(reply.text).toString()).toMatch(/\/fake\/connect\/cs_/);
    expect(alter.calls).toHaveLength(0);
  });

  it("shows an error page and stays unconnected when the user denies the provider", async () => {
    const reply = await host.callTool(alice, "alter_github_search_issues", SEARCH);
    const callback = alter.connect(linkIn(reply.text).toString(), { deny: true });
    const page = await fetch(callback);
    expect(page.status).toBe(400);
    expect(await page.text()).toContain("access_denied");
    expect((await host.callTool(alice, "alter_github_search_issues", SEARCH)).text).toMatch(/haven't connected GitHub/);
    expect(proxyRequests()).toBe(0);
  });

  it("finishes on the plugin's callback page, and the next call reaches GitHub through the agent's delegation", async () => {
    const prompt = await host.callTool(alice, "alter_github_search_issues", SEARCH);
    const page = await connectFrom(prompt.text);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("github connected");

    const reply = await host.callTool(alice, "alter_github_search_issues", SEARCH);
    expect(reply.isError).toBe(false);
    expect(reply.text).toContain(`Issue matching \\"${SEARCH.q}\\"`);

    // The agent proxies with its delegation id. The user's own grant id is a
    // 404 for an agent at Alter, so caching that would break every call.
    const [grant] = alter.grantsOf("alice");
    expect(alter.calls).toEqual([
      expect.objectContaining({
        sub: "alice",
        owner: "alice",
        provider: "github",
        grantId: grant!.delegationId,
        method: "GET",
        url: "https://api.github.com/search/issues",
        query: { q: SEARCH.q, per_page: 10 },
        reason: "alter_github_search_issues",
      }),
    ]);
  });

  it("finishes a connect for an account connected long ago, and refuses to replay its callback", async () => {
    // Connecting a provider the user already has reuses their grant at Alter,
    // so no delegation is newer than this connect session; the callback has
    // to fall back to the newest active one.
    alter.backdateGrants("alice", 10 * 60_000);
    const prompt = await host.command(alice, "connect github");
    const callback = alter.connect(linkIn(prompt.text).toString());
    const first = await fetch(callback);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("github connected");
    expect(alter.grantsOf("alice")).toHaveLength(1);
    expect((await fetch(callback)).status).toBe(400);
  });

  it("rejects a callback whose state was altered, without using up the real one", async () => {
    const prompt = await host.command(alice, "connect github");
    const callback = new URL(alter.connect(linkIn(prompt.text).toString()));
    const state = callback.searchParams.get("state")!;
    const dot = state.indexOf(".");
    const forged = new URL(callback);
    forged.searchParams.set("state", `${state.slice(0, dot + 1)}${state[dot + 1] === "A" ? "B" : "A"}${state.slice(dot + 2)}`);

    expect((await fetch(forged)).status).toBe(400);
    expect(host.logs.some((l) => l.level === "warn" && l.message.includes("state signature mismatch"))).toBe(true);
    expect((await fetch(callback)).status).toBe(200);
  });
});

describe("actions that need approval", () => {
  let approvalUrl: string;

  it("holds a write for the user's approval instead of running it", async () => {
    const before = alter.calls.length;
    const reply = await host.callTool(alice, "alter_github_create_issue", NEW_ISSUE);
    expect(reply.text).toMatch(/Awaiting your approval at/);
    approvalUrl = linkIn(reply.text).toString();
    expect(approvalUrl).toMatch(/\/fake\/approve\/ap_/);
    expect(alter.calls).toHaveLength(before);
    expect((await host.command(alice, "status")).text).toMatch(/Pending approval: (?!none)/);
  });

  it("repeats the same approval link while it is pending, without asking Alter twice", async () => {
    const before = proxyRequests();
    const reply = await host.callTool(alice, "alter_github_create_issue", NEW_ISSUE);
    expect(reply.text).toContain(approvalUrl);
    expect(proxyRequests()).toBe(before);
  });

  it("reports the approved action as done instead of sending it again", async () => {
    alter.decide(approvalUrl, "approved");
    const before = proxyRequests();
    const reply = await host.callTool(alice, "alter_github_create_issue", NEW_ISSUE);
    expect(reply.text).toMatch(/approved and already completed/);
    expect(proxyRequests()).toBe(before);
    expect((await host.command(alice, "status")).text).toContain("Pending approval: none");
  });

  it("says an approved action is still running while Alter runs it", async () => {
    const write = await host.callTool(alice, "alter_github_create_issue", { ...NEW_ISSUE, title: "Slow" });
    alter.decide(linkIn(write.text).toString(), "approved", { running: true });
    const before = proxyRequests();
    // Alter answers "approved", then "executing", then "executed".
    expect((await host.callTool(alice, "alter_github_create_issue", { ...NEW_ISSUE, title: "Slow" })).text).toMatch(/approved and is running now/);
    expect((await host.callTool(alice, "alter_github_create_issue", { ...NEW_ISSUE, title: "Slow" })).text).toMatch(/approved and is running now/);
    expect((await host.callTool(alice, "alter_github_create_issue", { ...NEW_ISSUE, title: "Slow" })).text).toMatch(/approved and already completed/);
    expect(proxyRequests()).toBe(before);
  });

  it("tells the user when an approved action failed at the provider", async () => {
    const write = await host.callTool(alice, "alter_github_create_issue", { ...NEW_ISSUE, title: "Broken" });
    alter.decide(linkIn(write.text).toString(), "approved", { failure: "GitHub answered 502" });
    const reply = await host.callTool(alice, "alter_github_create_issue", { ...NEW_ISSUE, title: "Broken" });
    expect(reply.text).toMatch(/failed during execution: GitHub answered 502/);
    expect((await host.command(alice, "status")).text).toContain("Pending approval: none");
  });

  it("tells the user when they denied it, and doesn't send it again", async () => {
    const reply = await host.callTool(alice, "alter_github_create_issue", { ...NEW_ISSUE, title: "Second" });
    alter.decide(linkIn(reply.text).toString(), "denied");
    const before = proxyRequests();
    const after = await host.callTool(alice, "alter_github_create_issue", { ...NEW_ISSUE, title: "Second" });
    expect(after.text).toMatch(/denied/i);
    expect(proxyRequests()).toBe(before);
  });
});

describe("when Alter stops trusting the session", () => {
  it("asks the user to sign in again when Alter rejects their token, then uses the new one", async () => {
    const oldToken = alter.calls.at(-1)!.tokenId;
    alter.revokeUserTokens("alice");
    const reply = await host.callTool(alice, "alter_github_search_issues", SEARCH);
    expect(reply.text).toMatch(/sign in/i);
    expect(linkIn(reply.text).toString()).toMatch(/\/fake\/sign-in\//);

    const refreshed = refreshedSignIns();
    alter.signIn(linkIn(reply.text).toString(), "alice");
    await eventually(() => refreshedSignIns() > refreshed);

    const again = await host.callTool(alice, "alter_github_search_issues", SEARCH);
    expect(again.text).toContain("Issue matching");
    expect(alter.calls.at(-1)!.sub).toBe("alice");
    expect(alter.calls.at(-1)!.tokenId).not.toBe(oldToken);
  });

  it("offers a reconnect link once the user revoked the provider in the wallet", async () => {
    expect(alter.revokeInWallet("alice", "github")).toBe(1);
    const reply = await host.callTool(alice, "alter_github_search_issues", SEARCH);
    expect(linkIn(reply.text).toString()).toMatch(/\/fake\/connect\//);
    // The dead delegation isn't kept: the next call asks to connect without trying it.
    const before = proxyRequests();
    expect((await host.callTool(alice, "alter_github_search_issues", SEARCH)).text).toMatch(/haven't connected GitHub/);
    expect(proxyRequests()).toBe(before);
  });
});

describe("revoking a connection", () => {
  it("revokes the user's grant at Alter, and the next call asks to connect again without trying the old one", async () => {
    expect((await connectFrom((await host.command(alice, "connect github")).text)).status).toBe(200);
    // A call first, so the plugin has the delegation cached when the user revokes.
    expect((await host.callTool(alice, "alter_github_search_issues", SEARCH)).isError).toBe(false);

    const active = alter.grantsOf("alice").filter((g) => g.status === "active");
    expect(active).toHaveLength(1);
    const list = await host.command(alice, "connections");
    // The user manages their own grant; the agent's delegation id isn't theirs to revoke.
    expect(list.text).toContain(active[0]!.grantId);
    expect(list.text).not.toContain(active[0]!.delegationId);

    const res = await host.command(alice, `connections revoke ${active[0]!.grantId}`);
    expect(res.text).toContain(`Revoked grant ${active[0]!.grantId}`);
    expect(alter.grantsOf("alice").every((g) => g.status === "revoked")).toBe(true);

    const before = proxyRequests();
    const reply = await host.callTool(alice, "alter_github_search_issues", SEARCH);
    expect(reply.text).toMatch(/haven't connected GitHub/);
    expect(proxyRequests()).toBe(before);
  });
});

describe("daily usage cap", () => {
  it("stops a user's tools once their sessions used up the daily model budget", async () => {
    await connectFrom((await host.command(alice, "connect github")).text);
    expect((await host.callTool(alice, "alter_github_search_issues", SEARCH)).isError).toBe(false);
    host.emit("llm_output", { sessionId: alice.sessionId, usage: { input: 1, output: 60_000 } });
    const before = proxyRequests();
    const reply = await host.callTool(alice, "alter_github_search_issues", SEARCH);
    expect(reply.isError).toBe(true);
    expect(reply.text).toMatch(/usage cap/i);
    expect(proxyRequests()).toBe(before);
  });
});
