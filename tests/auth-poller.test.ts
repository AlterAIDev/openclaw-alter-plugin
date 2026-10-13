import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { App, AuthResult } from "@alter-ai/alter-sdk";
import { ConnectTimeoutError } from "@alter-ai/alter-sdk";
import {
  AUTH_SESSION_DEFAULT_TTL_MS,
  AuthPoller,
  AuthSessionStore,
  type PendingAuthSession,
} from "../src/identity/auth-session.js";
import { closeDatabase } from "../src/sqlite.js";

const DB_KEY = randomBytes(32);
const HMAC_SECRET = randomBytes(32);
function newStore(tmp: string): AuthSessionStore {
  return new AuthSessionStore(tmp, DB_KEY, HMAC_SECRET);
}

/**
 * Minimal `App` stub exposing only what the poller touches:
 * `pollAuthSession`. The SDK owns the polling/transient-retry loop now, so the
 * poller's whole surface is "await one pollAuthSession, classify the outcome".
 */
function makeApp(
  pollAuthSession: (sessionToken: string) => Promise<AuthResult>,
): App {
  return { pollAuthSession } as unknown as App;
}

/** An `AuthResult`-shaped value (the SDK class, duck-typed for tests). */
function authResult(userToken: string, userInfo: Record<string, unknown>): AuthResult {
  return { userToken, userInfo } as unknown as AuthResult;
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "alter-poll-"));
});
afterEach(() => {
  closeDatabase();
  rmSync(tmp, { recursive: true, force: true });
});

function makePending(): PendingAuthSession {
  return {
    sessionToken: `tok-${Math.random().toString(36).slice(2)}`,
    channelKind: "slack",
    channelUserId: "U1",
    chatSessionId: "sess",
    authUrl: "https://example/auth",
    iatMs: Date.now(),
    ttlMs: AUTH_SESSION_DEFAULT_TTL_MS,
    status: "pending",
  };
}

describe("AuthPoller", () => {
  it("calls onCompleted with user token + info on a resolved poll, then deletes the row", async () => {
    const store = newStore(tmp);
    const s = makePending();
    store.insert(s);

    const onCompleted = vi.fn().mockResolvedValue(undefined);
    const onCompletedError = vi.fn();
    const onExpired = vi.fn();
    const onFailed = vi.fn();

    const app = makeApp(async () => authResult("jwt-1", { sub: "u" }));
    const poller = new AuthPoller(app, store, {
      onCompleted,
      onCompletedError,
      onExpired,
      onFailed,
    });
    poller.start(s);

    await vi.waitFor(() => expect(onCompleted).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });
    expect(onCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ sessionToken: s.sessionToken }),
      "jwt-1",
      { sub: "u" },
    );
    // Row gets deleted after the callback runs.
    await vi.waitFor(() => expect(store.get(s.sessionToken)).toBeUndefined(), {
      timeout: 1000,
    });
    expect(onExpired).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(onCompletedError).not.toHaveBeenCalled();
  });

  it("passes the session's remaining TTL as the poll timeout", async () => {
    const store = newStore(tmp);
    const s = makePending();
    store.insert(s);

    const pollAuthSession = vi
      .fn<App["pollAuthSession"]>()
      .mockResolvedValue(authResult("jwt-1", {}));
    const app = { pollAuthSession } as unknown as App;
    const poller = new AuthPoller(app, store, { onCompleted: vi.fn().mockResolvedValue(undefined) });
    poller.start(s);

    await vi.waitFor(() => expect(pollAuthSession).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });
    expect(pollAuthSession).toHaveBeenCalledWith(
      s.sessionToken,
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    const timeoutMs = (pollAuthSession.mock.calls[0]?.[1] as { timeoutMs: number }).timeoutMs;
    // ~10 min TTL minus the few ms elapsed since insert.
    expect(timeoutMs).toBeGreaterThan(AUTH_SESSION_DEFAULT_TTL_MS - 5_000);
    expect(timeoutMs).toBeLessThanOrEqual(AUTH_SESSION_DEFAULT_TTL_MS);
  });

  it("fires onCompletedError when onCompleted throws but still deletes the row", async () => {
    const store = newStore(tmp);
    const s = makePending();
    store.insert(s);

    const persistErr = new Error("disk full");
    const onCompleted = vi.fn().mockRejectedValue(persistErr);
    const onCompletedError = vi.fn();

    const app = makeApp(async () => authResult("jwt-1", {}));
    const poller = new AuthPoller(app, store, {
      onCompleted,
      onCompletedError,
    });
    poller.start(s);

    await vi.waitFor(() => expect(onCompletedError).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });
    expect(onCompletedError).toHaveBeenCalledWith(
      expect.objectContaining({ sessionToken: s.sessionToken }),
      persistErr,
    );
    // JWT was burned on the Alter side — row deleted even though persist failed.
    await vi.waitFor(() => expect(store.get(s.sessionToken)).toBeUndefined(), {
      timeout: 1000,
    });
  });

  it("treats a synchronous onCompleted throw like a rejection", async () => {
    // onCompleted may be a plain function (the plugin's is): its throw must
    // still reach onCompletedError and the row must still be deleted.
    const store = newStore(tmp);
    const s = makePending();
    store.insert(s);

    const persistErr = new Error("disk full");
    const onCompleted = vi.fn((): void => {
      throw persistErr;
    });
    const onCompletedError = vi.fn();

    const app = makeApp(async () => authResult("jwt-1", {}));
    const poller = new AuthPoller(app, store, {
      onCompleted,
      onCompletedError,
    });
    poller.start(s);

    await vi.waitFor(() => expect(onCompletedError).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });
    expect(onCompletedError).toHaveBeenCalledWith(
      expect.objectContaining({ sessionToken: s.sessionToken }),
      persistErr,
    );
    await vi.waitFor(() => expect(store.get(s.sessionToken)).toBeUndefined(), {
      timeout: 1000,
    });
  });

  it("maps a ConnectTimeoutError to expired (user never finished signing in)", async () => {
    const store = newStore(tmp);
    const s = makePending();
    store.insert(s);

    const onExpired = vi.fn();
    const onFailed = vi.fn();
    const app = makeApp(async () => {
      throw new ConnectTimeoutError("user did not complete login in time");
    });
    const poller = new AuthPoller(app, store, {
      onCompleted: vi.fn(),
      onExpired,
      onFailed,
    });
    poller.start(s);

    await vi.waitFor(() => expect(onExpired).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });
    expect(onFailed).not.toHaveBeenCalled();
    expect(store.get(s.sessionToken)?.status).toBe("expired");
  });

  it("maps a terminal poll error to failed", async () => {
    const store = newStore(tmp);
    const s = makePending();
    store.insert(s);

    const onFailed = vi.fn();
    const app = makeApp(async () => {
      throw new Error("IDP returned a terminal error");
    });
    const poller = new AuthPoller(app, store, {
      onCompleted: vi.fn(),
      onFailed,
    });
    poller.start(s);

    await vi.waitFor(() => expect(onFailed).toHaveBeenCalledTimes(1), {
      timeout: 1000,
    });
    const reason = String(onFailed.mock.calls[0]?.[1] ?? "");
    expect(reason).toContain("terminal error");
    expect(store.get(s.sessionToken)?.status).toBe("failed");
  });

  it("does not start a second loop for the same session token", async () => {
    // start() must be idempotent per session token — a duplicate start while a
    // poll is already in flight must not issue a second pollAuthSession.
    const store = newStore(tmp);
    const s = makePending();
    store.insert(s);

    let pollCalls = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = makeApp(async () => {
      pollCalls++;
      // Hold the in-flight poll so the loop can't complete and clean up.
      await held;
      return authResult("jwt-1", {});
    });

    const poller = new AuthPoller(app, store, { onCompleted: vi.fn().mockResolvedValue(undefined) });
    poller.start(s);
    poller.start(s); // second start() must be a no-op
    poller.start(s); // third start() must also be a no-op

    await vi.waitFor(() => expect(pollCalls).toBeGreaterThanOrEqual(1), {
      timeout: 1000,
    });
    expect(pollCalls).toBe(1);

    poller.cancel(s.sessionToken);
    release();
  });

  it.each([
    ["completes", () => authResult("jwt-late", { sub: "u" })],
    ["fails", () => {
      throw new Error("Authentication session expired");
    }],
  ] as const)("writes nothing after stopAll, even when the in-flight poll then %s", async (_, outcome) => {
    const store = newStore(tmp);
    const s = makePending();
    store.insert(s);

    let settled = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = makeApp(async () => {
      await held;
      try {
        return outcome();
      } finally {
        settled = true;
      }
    });
    const onCompleted = vi.fn();
    const onFailed = vi.fn();
    const onExpired = vi.fn();
    const poller = new AuthPoller(app, store, { onCompleted, onFailed, onExpired });
    poller.start(s);

    poller.stopAll();
    release();
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1000 });
    // Let the loop's continuation run after the poll settles.
    await new Promise((resolve) => setImmediate(resolve));

    expect(onCompleted).not.toHaveBeenCalled();
    expect(onFailed).not.toHaveBeenCalled();
    expect(onExpired).not.toHaveBeenCalled();
    // Still pending, so the next boot's resumePending picks it up.
    expect(store.get(s.sessionToken)?.status).toBe("pending");
  });

  it("resumePending starts loops only for non-expired pending rows", () => {
    const store = newStore(tmp);
    const fresh = makePending();
    store.insert(fresh);
    const stale = {
      ...makePending(),
      iatMs: Date.now() - AUTH_SESSION_DEFAULT_TTL_MS - 1,
    };
    store.insert(stale);

    // Never-resolving poll so the resumed loop stays in flight for the assert.
    const app = makeApp(() => new Promise<AuthResult>(() => {}));
    const poller = new AuthPoller(app, store, { onCompleted: vi.fn() });
    const resumed = poller.resumePending(Date.now());
    expect(resumed).toBe(1);
    poller.cancel(fresh.sessionToken);
  });
});
