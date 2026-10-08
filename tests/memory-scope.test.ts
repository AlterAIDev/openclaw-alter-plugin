import { describe, expect, it, vi } from "vitest";
import type { Agent } from "@alter-ai/alter-sdk";
import { MemoryScopeError, MemoryScopeResolver } from "../src/memory/scope.js";

/**
 * The scope resolver turns a sealed JWT into a verified partition key by asking
 * Alter. Its job is to be RIGHT or to REFUSE — there is no safe fallback, since
 * any locally-invented key either collides users or writes somewhere nobody can
 * read back.
 */

function fakeAgent(
  resolveIdentity: (opts: { userToken?: string }) => Promise<unknown> | unknown,
): { agent: Agent; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(resolveIdentity);
  return { agent: { resolveIdentity: spy } as unknown as Agent, spy };
}

/** Mirrors the SDK's IdentityContext surface for the bits we use. */
function identity(opts: { userKey: string | null; userStatus?: string | null }) {
  return {
    userStatus: opts.userStatus === undefined ? "active" : opts.userStatus,
    memoryScope: () => ({
      userKey: opts.userKey,
      agentKey: "alter:agent:agent-1",
      appKey: "alter:app:app-1",
      runKey: null,
      namespace: ["alter", "app-1"],
    }),
  };
}

describe("MemoryScopeResolver", () => {
  it("returns Alter's userKey, derived from the JWT", async () => {
    const { agent, spy } = fakeAgent(async () =>
      identity({ userKey: "alter:user:canonical-uuid" }),
    );
    const r = new MemoryScopeResolver(agent);
    expect(await r.resolve("idp:auth0|abc", "the.jwt")).toBe("alter:user:canonical-uuid");
    // The JWT is what Alter resolves from — not our local id.
    expect(spy).toHaveBeenCalledWith({ userToken: "the.jwt" });
  });

  it("passes the LOCAL id only as a cache bucket, never as the key", async () => {
    // The returned key must come from Alter, even though we hand it a local id
    // to cache under. If these were ever confused, memory would be keyed on the
    // raw IDP sub — the exact thing Alter's guide forbids.
    const { agent } = fakeAgent(async () => identity({ userKey: "alter:user:real-one" }));
    const r = new MemoryScopeResolver(agent);
    const key = await r.resolve("idp:auth0|abc", "jwt");
    expect(key).toBe("alter:user:real-one");
    expect(key).not.toContain("auth0");
    expect(key).not.toContain("idp:");
  });

  it("gives different users different keys", async () => {
    const { agent } = fakeAgent(async (opts) =>
      identity({ userKey: `alter:user:${opts.userToken === "jwt-a" ? "aaa" : "bbb"}` }),
    );
    const r = new MemoryScopeResolver(agent);
    expect(await r.resolve("idp:a", "jwt-a")).toBe("alter:user:aaa");
    expect(await r.resolve("idp:b", "jwt-b")).toBe("alter:user:bbb");
  });

  it("REFUSES when Alter can't resolve the identity (no fallback key)", async () => {
    // A fallback here would be the "defaults to default_user" bug.
    const { agent } = fakeAgent(async () => {
      throw new Error("user has been deprovisioned from identity provider");
    });
    const r = new MemoryScopeResolver(agent);
    await expect(r.resolve("idp:auth0|abc", "jwt")).rejects.toThrow(MemoryScopeError);
  });

  it("REFUSES a non-active identity", async () => {
    // Defence in depth: the SDK says suspended users are rejected rather than
    // returned, but we must not partition memory for one if that ever changes.
    const { agent } = fakeAgent(async () =>
      identity({ userKey: "alter:user:x", userStatus: "suspended" }),
    );
    const r = new MemoryScopeResolver(agent);
    await expect(r.resolve("idp:x", "jwt")).rejects.toThrow(/not active/);
  });

  it("REFUSES a headless context (null userKey — no owner)", async () => {
    const { agent } = fakeAgent(async () => identity({ userKey: null }));
    const r = new MemoryScopeResolver(agent);
    await expect(r.resolve("idp:x", "jwt")).rejects.toThrow(/no owner/);
  });

  it("fails CLOSED on a malformed identity shape (no raw TypeError escapes)", async () => {
    // SDK version skew: resolveIdentity resolves, but the object it hands back
    // is missing memoryScope(). Accessing it would throw a raw TypeError; the
    // resolver must turn that into a MemoryScopeError so the tool fails closed
    // with its friendly message instead of throwing an unhandled error.
    const { agent } = fakeAgent(async () => ({ userStatus: "active" }));
    const r = new MemoryScopeResolver(agent);
    await expect(r.resolve("idp:x", "jwt")).rejects.toThrow(MemoryScopeError);
    await expect(r.resolve("idp:x", "jwt")).rejects.toThrow(/unexpected identity shape/);
  });

  it("caches so repeated memory calls don't round-trip per call", async () => {
    const { agent, spy } = fakeAgent(async () => identity({ userKey: "alter:user:x" }));
    const r = new MemoryScopeResolver(agent);
    await r.resolve("idp:x", "jwt");
    await r.resolve("idp:x", "jwt");
    await r.resolve("idp:x", "jwt");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("re-resolves once the cache TTL lapses", async () => {
    const { agent, spy } = fakeAgent(async () => identity({ userKey: "alter:user:x" }));
    const r = new MemoryScopeResolver(agent, 1000);
    const t0 = Date.now();
    await r.resolve("idp:x", "jwt", t0);
    await r.resolve("idp:x", "jwt", t0 + 500);
    expect(spy).toHaveBeenCalledTimes(1);
    await r.resolve("idp:x", "jwt", t0 + 1500);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("does not cache different users under one bucket", async () => {
    const { agent } = fakeAgent(async (o) =>
      identity({ userKey: `alter:user:${o.userToken}` }),
    );
    const r = new MemoryScopeResolver(agent);
    expect(await r.resolve("idp:a", "aaa")).toBe("alter:user:aaa");
    expect(await r.resolve("idp:b", "bbb")).toBe("alter:user:bbb");
    // ...and the first is still itself, not overwritten.
    expect(await r.resolve("idp:a", "aaa")).toBe("alter:user:aaa");
  });

  it("does not cache a FAILURE (a transient error must not wedge memory)", async () => {
    let fail = true;
    const { agent } = fakeAgent(async () => {
      if (fail) throw new Error("network blip");
      return identity({ userKey: "alter:user:x" });
    });
    const r = new MemoryScopeResolver(agent);
    await expect(r.resolve("idp:x", "jwt")).rejects.toThrow(MemoryScopeError);
    fail = false;
    await expect(r.resolve("idp:x", "jwt")).resolves.toBe("alter:user:x");
  });

  it("singleflights concurrent resolves for the same user", async () => {
    const { agent, spy } = fakeAgent(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return identity({ userKey: "alter:user:x" });
    });
    const r = new MemoryScopeResolver(agent);
    const all = await Promise.all([
      r.resolve("idp:x", "jwt"),
      r.resolve("idp:x", "jwt"),
      r.resolve("idp:x", "jwt"),
    ]);
    expect(all).toEqual(["alter:user:x", "alter:user:x", "alter:user:x"]);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("invalidate() forces a fresh resolve (e.g. after a re-link)", async () => {
    const { agent, spy } = fakeAgent(async () => identity({ userKey: "alter:user:x" }));
    const r = new MemoryScopeResolver(agent);
    await r.resolve("idp:x", "jwt");
    r.invalidate("idp:x");
    await r.resolve("idp:x", "jwt");
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
