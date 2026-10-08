import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  InsufficientScopeError,
  PolicyViolationError,
  ReAuthRequiredError,
  type Agent,
} from "@alter-ai/alter-sdk";
import { IdentityStore } from "../src/identity/store.js";
import { RateLimitStore } from "../src/rate-limit/store.js";
import { MemoryStore } from "../src/memory/store.js";
import { MemoryScopeResolver } from "../src/memory/scope.js";
import { registerMemoryTools, type MemoryToolDeps } from "../src/memory/tools.js";
import { closeDatabase } from "../src/sqlite.js";

/**
 * The memory tools end-to-end.
 *
 * The headline test is `two users in ONE shared session`: it reproduces the
 * condition under which a shared transcript leaks (one session, several people)
 * and shows that memory does NOT leak under it — because memory is partitioned
 * on Alter's verified identity, not on the session. That is the property that
 * makes memory safe to enable at all.
 */

interface Env {
  run: (tool: string, params: Record<string, unknown>, as: { channelUserId: string }) =>
    Promise<{ isError: boolean; text: string }>;
  memories: MemoryStore;
  identities: IdentityStore;
  logger: { info: Mock; warn: Mock; error: Mock };
  cleanup: () => void;
}

const SESSION = "agent:main:main"; // ONE session shared by several people

function makeEnv(
  opts: {
    resolveIdentity?: (o: { userToken?: string }) => Promise<unknown> | unknown;
    users?: Array<{ channelUserId: string; appUserId: string; jwt: string; expired?: boolean }>;
    startLogin?: () => Promise<string>;
  } = {},
): Env {
  const tmp = mkdtempSync(join(tmpdir(), "alter-memtools-"));
  const identities = new IdentityStore(tmp, randomBytes(32));
  const rateLimit = new RateLimitStore(tmp, {
    inputTokensPerDay: 1_000_000,
    outputTokensPerDay: 1_000_000,
  });
  const memories = new MemoryStore(tmp);

  const users = opts.users ?? [
    { channelUserId: "U-alice", appUserId: "idp:auth0|alice", jwt: "jwt-alice" },
    { channelUserId: "U-bob", appUserId: "idp:auth0|bob", jwt: "jwt-bob" },
  ];
  for (const u of users) {
    identities.upsert({
      channelKind: "slack",
      channelUserId: u.channelUserId,
      appUserId: u.appUserId,
      idpSub: u.appUserId.replace("idp:", ""),
      jwt: u.jwt,
      jwtExpiresAt: u.expired ? Date.now() - 1000 : Date.now() + 3_600_000,
    });
  }

  // Alter maps each JWT to a canonical, stable user key.
  const resolveIdentity =
    opts.resolveIdentity ??
    (async (o: { userToken?: string }) => ({
      userStatus: "active",
      memoryScope: () => ({
        userKey: `alter:user:${o.userToken?.replace("jwt-", "")}`,
        agentKey: "alter:agent:a",
        appKey: "alter:app:a",
        runKey: null,
        namespace: ["alter", "a"],
      }),
    }));
  const agent = { resolveIdentity: vi.fn(resolveIdentity) } as unknown as Agent;

  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const deps: MemoryToolDeps = {
    identities,
    rateLimit,
    memories,
    scopes: new MemoryScopeResolver(agent),
    channelHashSalt: "salt",
    startLogin: vi.fn(opts.startLogin ?? (async () => "https://login.test/start")),
  };

  const registered = new Map<string, (ctx: unknown) => { execute: Function }>();
  const api = {
    logger,
    registerTool: (factory: unknown, o: { name: string }) => {
      registered.set(o.name, factory as (ctx: unknown) => { execute: Function });
    },
  } as unknown as Parameters<typeof registerMemoryTools>[0];
  registerMemoryTools(api, deps);

  return {
    run: async (tool, params, as) => {
      const factory = registered.get(tool)!;
      const t = factory({
        sessionId: SESSION,
        messageChannel: "slack",
        requesterSenderId: as.channelUserId,
      });
      const r = (await t.execute("id", params)) as {
        isError: boolean;
        content: Array<{ text: string }>;
      };
      return { isError: r.isError, text: r.content.map((c) => c.text).join("") };
    },
    memories,
    identities,
    logger,
    cleanup: () => {
      closeDatabase();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

let env: Env | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
});

const ALICE = { channelUserId: "U-alice" };
const BOB = { channelUserId: "U-bob" };

describe("THE POINT: memory does not leak between users in ONE shared session", () => {
  it("Bob cannot recall what Alice remembered, in the same session", async () => {
    // One session (agent:main:main), two people: the shape under which the
    // transcript is shared. Memory must not be.
    env = makeEnv();
    await env.run("alter_memory_remember", { content: "Alice is emailing Carol about PRs" }, ALICE);

    const alice = await env.run("alter_memory_recall", {}, ALICE);
    expect(alice.text).toContain("Alice is emailing Carol");

    const bob = await env.run("alter_memory_recall", {}, BOB);
    expect(bob.text).toContain("Nothing remembered");
    expect(bob.text).not.toContain("Carol");
  });

  it("Bob cannot find Alice's memory by searching for it", async () => {
    env = makeEnv();
    await env.run("alter_memory_remember", { content: "codename Bluebird is the Q3 launch" }, ALICE);
    const bob = await env.run("alter_memory_recall", { query: "Bluebird" }, BOB);
    // Assert on ALICE'S CONTENT, not the search term — the "no matches" reply
    // legitimately echoes Bob's own query back to him.
    expect(bob.text).not.toContain("Q3 launch");
    expect(bob.text).toContain("No memories matching");
    // ...and Alice can still find her own.
    expect((await env.run("alter_memory_recall", { query: "Bluebird" }, ALICE)).text).toContain(
      "Q3 launch",
    );
  });

  it("Bob cannot forget Alice's memory even with its id", async () => {
    env = makeEnv();
    const stored = await env.run("alter_memory_remember", { content: "alice note" }, ALICE);
    const id = /id: ([0-9a-f-]+)/.exec(stored.text)?.[1];
    expect(id).toBeTruthy();

    const bob = await env.run("alter_memory_forget", { id }, BOB);
    expect(bob.isError).toBe(true);
    expect(bob.text).toContain("No memory of yours");
    // Alice's is untouched.
    expect((await env.run("alter_memory_recall", {}, ALICE)).text).toContain("alice note");
  });

  it("Bob's forget-all does not touch Alice", async () => {
    env = makeEnv();
    await env.run("alter_memory_remember", { content: "alice note" }, ALICE);
    await env.run("alter_memory_remember", { content: "bob note" }, BOB);
    await env.run("alter_memory_forget", { all: true }, BOB);
    expect((await env.run("alter_memory_recall", {}, ALICE)).text).toContain("alice note");
    expect((await env.run("alter_memory_recall", {}, BOB)).text).toContain("Nothing remembered");
  });

  it("partitions on ALTER's key, not the session and not the local id", async () => {
    // Two channel-users whose LOCAL ids differ but who Alter says are the SAME
    // person (e.g. the same human on two Slack accounts). Memory should follow
    // Alter's answer, not ours.
    env = makeEnv({
      users: [
        { channelUserId: "U-a1", appUserId: "idp:auth0|same", jwt: "jwt-same" },
        { channelUserId: "U-a2", appUserId: "idp:okta|same", jwt: "jwt-same" },
      ],
    });
    await env.run("alter_memory_remember", { content: "shared human note" }, { channelUserId: "U-a1" });
    const other = await env.run("alter_memory_recall", {}, { channelUserId: "U-a2" });
    // Same Alter identity -> same memory. This is the behaviour that keying on
    // the raw IDP sub would have broken.
    expect(other.text).toContain("shared human note");
  });
});

describe("memory tools fail closed", () => {
  it("refuses to touch memory when Alter can't verify identity", async () => {
    env = makeEnv({
      resolveIdentity: async () => {
        throw new Error("user has been deprovisioned from identity provider");
      },
    });
    const res = await env.run("alter_memory_remember", { content: "x" }, ALICE);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("couldn't verify your identity");
    expect(env.logger.warn).toHaveBeenCalled();
  });

  it("stores NOTHING when identity can't be verified", async () => {
    env = makeEnv({
      resolveIdentity: async () => {
        throw new Error("alter down");
      },
    });
    await env.run("alter_memory_remember", { content: "must not persist" }, ALICE);
    // No partition => no write. Not even to a fallback bucket.
    expect(env.memories.count("alter:user:jwt-alice")).toBe(0);
  });

  it("offers a fresh sign-in when Alter rejects the sign-in token, and stores nothing", async () => {
    // A rejected token can't be fixed by retrying, so "try again shortly" would
    // loop. Still fail closed: no verified key means no read or write.
    env = makeEnv({
      resolveIdentity: async () => {
        throw new ReAuthRequiredError("JWT validation failed: Signature has expired", {
          status_code: 401,
          error: "jwt_validation_error",
        });
      },
    });
    const res = await env.run("alter_memory_remember", { content: "must not persist" }, ALICE);
    expect(res.isError).toBe(false);
    expect(res.text).toContain("Alter rejected your sign-in, so you need to sign in again.");
    expect(res.text).toContain("https://login.test/start");
    expect(res.text).not.toContain("Try again shortly");
    expect(env.memories.count("alter:user:alice")).toBe(0);
    const warn = env.logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warn).toContain("sign-in token rejected by Alter");
  });

  it("says the operator must fix the key when the agent key can't resolve identities", async () => {
    env = makeEnv({
      resolveIdentity: async () => {
        throw new InsufficientScopeError("Missing required scope(s): identity:resolve", {
          required: ["identity:resolve"],
          missing: ["identity:resolve"],
          details: { status_code: 403, error: "insufficient_scope" },
        });
      },
    });
    const res = await env.run("alter_memory_remember", { content: "must not persist" }, ALICE);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Alter API key is missing a permission");
    expect(res.text).not.toContain("Try again shortly");
    expect(env.memories.count("alter:user:alice")).toBe(0);
    expect(String(env.logger.error.mock.calls[0]?.[0])).toContain(
      "could not resolve the memory owner: the Alter API key is missing scope(s) [identity:resolve]",
    );
  });

  it("tells a deprovisioned user an administrator must act, and stores nothing", async () => {
    // Alter refuses a deprovisioned user outright (403). "Try again shortly"
    // would loop forever.
    env = makeEnv({
      resolveIdentity: async () => {
        throw new PolicyViolationError("The end user has been deprovisioned.", "user_deprovisioned", {
          status_code: 403,
          error: "user_deprovisioned",
        });
      },
    });
    const res = await env.run("alter_memory_remember", { content: "must not persist" }, ALICE);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Your Alter identity has been deprovisioned");
    expect(res.text).toContain("an administrator must re-provision");
    expect(res.text).not.toContain("Try again shortly");
    expect(env.memories.count("alter:user:alice")).toBe(0);
    const warn = env.logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warn).toContain("refused: identity deprovisioned");
  });

  it("tells a suspended user an administrator must act (Alter returns them; the resolver refuses)", async () => {
    env = makeEnv({
      resolveIdentity: async () => ({
        userStatus: "suspended",
        memoryScope: () => ({ userKey: "alter:user:alice" }),
      }),
    });
    const res = await env.run("alter_memory_recall", {}, ALICE);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Your Alter identity has been suspended");
    expect(res.text).toContain("an administrator must reactivate");
    expect(res.text).not.toContain("Try again shortly");
  });

  it("logs a sign-in that won't start, never echoing the error to the chat", async () => {
    env = makeEnv({
      users: [],
      startLogin: async () => {
        throw new Error("createAuthSession failed: internal detail");
      },
    });
    const res = await env.run("alter_memory_remember", { content: "x" }, ALICE);
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      "You need to sign in, but I couldn't start the sign-in flow. Try again shortly.",
    );
    const warn = env.logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warn).toContain("alter_memory_remember could not start a sign-in: Error: createAuthSession failed");
  });

  it("prompts sign-in when the user has no identity", async () => {
    env = makeEnv({ users: [] });
    const res = await env.run("alter_memory_remember", { content: "x" }, ALICE);
    expect(res.isError).toBe(false);
    expect(res.text).toContain("https://login.test/start");
  });

  it("prompts re-link when the JWT has expired", async () => {
    env = makeEnv({
      users: [
        { channelUserId: "U-alice", appUserId: "idp:auth0|alice", jwt: "jwt-alice", expired: true },
      ],
    });
    const res = await env.run("alter_memory_recall", {}, ALICE);
    expect(res.text).toContain("sign-in expired");
  });

  it("rejects params that violate the schema", async () => {
    env = makeEnv();
    expect((await env.run("alter_memory_remember", { content: "" }, ALICE)).isError).toBe(true);
    expect((await env.run("alter_memory_recall", { limit: 999 }, ALICE)).isError).toBe(true);
  });

  it("refuses forget with both id and all", async () => {
    env = makeEnv();
    const res = await env.run("alter_memory_forget", { id: "x", all: true }, ALICE);
    expect(res.isError).toBe(true);
    expect(res.text).toContain("not both");
  });

  it("refuses forget with neither id nor all", async () => {
    env = makeEnv();
    const res = await env.run("alter_memory_forget", {}, ALICE);
    expect(res.isError).toBe(true);
  });
});

describe("the LLM cannot choose whose memory it touches", () => {
  it("ignores a user id smuggled in as a tool parameter", async () => {
    // "the identity argument of a memory call is plumbing, never a tool
    // parameter the LLM fills in". A prompt-injected call passing someone
    // else's id must not reach their partition — the schema has no such field,
    // and the key comes from the JWT regardless.
    env = makeEnv();
    await env.run("alter_memory_remember", { content: "alice private" }, ALICE);
    const res = await env.run(
      "alter_memory_recall",
      { userKey: "alter:user:jwt-alice", user_id: "idp:auth0|alice", appUserId: "idp:auth0|alice" },
      BOB,
    );
    expect(res.text).not.toContain("alice private");
    expect(res.text).toContain("Nothing remembered");
  });

  it("does not echo the partition key back to the model", async () => {
    // The key is plumbing; surfacing it invites the model to reason about it.
    env = makeEnv();
    await env.run("alter_memory_remember", { content: "note" }, ALICE);
    const res = await env.run("alter_memory_recall", {}, ALICE);
    expect(res.text).not.toContain("alter:user:");
  });
});
