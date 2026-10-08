import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  BackendError,
  InsufficientScopeError,
  InvalidKeyError,
  PolicyViolationError,
  ReAuthRequiredError,
  type Agent,
  type App,
} from "@alter-ai/alter-sdk";
import type {
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { registerCommands, type CommandsDeps } from "../src/commands.js";
import { IdentityStore } from "../src/identity/store.js";
import { closeDatabase } from "../src/sqlite.js";

/**
 * `/alter` failure replies. A command that fails must not show the user the
 * raw SDK/backend error (it carries internal detail, the same reason the tools
 * never echo one). The error goes to the operator log, and the user gets a
 * generic reply, except for the two failures a generic "try again" would loop
 * on: a rejected sign-in and an inactive identity.
 */

const CHANNEL = "slack";
const CHANNEL_USER = "U999";
const APP_USER = "idp:cmduser";
const INTERNAL = "internal backend detail";

const tokenRejected = (): ReAuthRequiredError =>
  new ReAuthRequiredError("JWT validation failed: Signature has expired", {
    status_code: 401,
    error: "jwt_validation_error",
  });

function setup(opts: {
  createAuthSession?: () => Promise<{ authUrl: string; sessionToken: string }>;
  createConnectSession?: () => Promise<{ connectUrl: string }>;
  listGrants?: () => Promise<unknown>;
  revokeGrant?: () => Promise<unknown>;
}): {
  run: (args: string) => Promise<PluginCommandResult>;
  warn: Mock;
  error: Mock;
  cleanup: () => void;
} {
  const tmp = mkdtempSync(join(tmpdir(), "alter-cmd-errors-"));
  const identities = new IdentityStore(tmp, randomBytes(32));
  identities.upsert({
    channelKind: CHANNEL,
    channelUserId: CHANNEL_USER,
    appUserId: APP_USER,
    idpSub: "cmduser",
    jwt: "cmd.jwt.token",
    jwtExpiresAt: Date.now() + 60 * 60 * 1000,
  });

  const app = {
    createAuthSession: vi.fn(
      opts.createAuthSession ?? (async () => ({ authUrl: "https://login.test", sessionToken: "t" })),
    ),
    listGrants: vi.fn(
      opts.listGrants ??
        (async (args: { limit: number; offset: number }) => ({
          grants: [],
          hasMore: false,
          total: 0,
          limit: args.limit,
          offset: args.offset,
        })),
    ),
    revokeGrant: vi.fn(opts.revokeGrant ?? (async () => ({ success: true }))),
  } as unknown as App;
  const agent = {
    createConnectSession: vi.fn(
      opts.createConnectSession ?? (async () => ({ connectUrl: "https://connect.test" })),
    ),
  } as unknown as Agent;

  const deps = {
    cfg: { publicBaseUrl: "https://gateway.test", walletBaseUrl: "https://wallet.test" },
    app,
    agent,
    identities,
    grants: { delete: vi.fn() },
    pending: { insert: vi.fn() },
    stateHmac: { sign: () => "signed-state" },
    loginRateLimit: { check: () => ({ allowed: true, retryAfterSeconds: 0 }) },
    authSessions: { insert: vi.fn(), get: () => undefined },
    authPoller: { start: vi.fn() },
  } as unknown as CommandsDeps;

  const warn = vi.fn();
  const error = vi.fn();
  let handler: ((ctx: PluginCommandContext) => Promise<PluginCommandResult>) | undefined;
  const api = {
    logger: { info: vi.fn(), warn, error },
    registerCommand: (cmd: {
      handler: (ctx: PluginCommandContext) => Promise<PluginCommandResult>;
    }): void => {
      handler = cmd.handler;
    },
  } as unknown as Parameters<typeof registerCommands>[0];
  registerCommands(api, deps);
  if (!handler) throw new Error("alter command not registered");

  return {
    run: (args) =>
      handler!({
        channel: CHANNEL,
        senderId: CHANNEL_USER,
        sessionId: "sess-cmd",
        args,
      } as unknown as PluginCommandContext),
    warn,
    error,
    cleanup: () => {
      closeDatabase();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

let active: { cleanup: () => void } | undefined;
afterEach(() => active?.cleanup());

function logged(warn: Mock): string {
  return warn.mock.calls.map((c) => String(c[0])).join("\n");
}

describe("/alter command failures", () => {
  it("login: generic reply, error and key hint in the log only", async () => {
    const hint = "Keys created before the September 2026 key-security upgrade must be replaced.";
    const env = setup({
      createAuthSession: async () => {
        throw new InvalidKeyError({
          message: INTERNAL,
          details: { status_code: 401, error: "invalid_key" },
          hint,
        });
      },
    });
    active = env;
    const res = await env.run("login");
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      "Couldn't start sign-in. Try again shortly; if it keeps failing, ask the operator to check the gateway log.",
    );
    expect(res.text).not.toContain(INTERNAL);
    expect(logged(env.warn)).toContain(`/alter could not start sign-in: InvalidKeyError: ${INTERNAL}`);
    expect(logged(env.warn)).toContain(`hint=${JSON.stringify(hint)}`);
  });

  it("login: an app key missing a scope says the operator must fix the key, scope logged", async () => {
    const env = setup({
      createAuthSession: async () => {
        throw new InsufficientScopeError("Missing required scope(s): idp_users:write", {
          required: ["idp_users:write"],
          missing: ["idp_users:write"],
          details: { status_code: 403, error: "insufficient_scope" },
        });
      },
    });
    active = env;
    const res = await env.run("login");
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      "This assistant's Alter API key is missing a permission it needs, so this can't work " +
        "until the operator fixes the key. Retrying or signing in again won't help.",
    );
    expect(String(env.error.mock.calls[0]?.[0])).toContain(
      "/alter could not start sign-in: the Alter API key is missing scope(s) [idp_users:write]",
    );
    expect(env.warn).not.toHaveBeenCalled();
  });

  it("connect <provider>: a rejected sign-in says to sign in again", async () => {
    const env = setup({ createConnectSession: async () => { throw tokenRejected(); } });
    active = env;
    const res = await env.run("connect github");
    expect(res.isError).toBe(true);
    expect(res.text).toBe("Alter rejected your sign-in. Run /alter login to sign in again, then retry.");
    expect(logged(env.warn)).toContain("/alter could not start GitHub connect");
  });

  it("connect menu: one sign-in reply instead of a row of identical failures", async () => {
    const env = setup({ createConnectSession: async () => { throw tokenRejected(); } });
    active = env;
    const res = await env.run("connect");
    expect(res.text).toBe("Alter rejected your sign-in. Run /alter login to sign in again, then retry.");
  });

  it("connect menu: a provider that fails shows as unavailable, error logged", async () => {
    let n = 0;
    const env = setup({
      createConnectSession: async () => {
        n += 1;
        if (n === 1) throw new BackendError(INTERNAL, { status_code: 500 });
        return { connectUrl: "https://connect.test" };
      },
      listGrants: async () => { throw new BackendError("list failed: " + INTERNAL, { status_code: 503 }); },
    });
    active = env;
    const res = await env.run("connect");
    expect(res.isError).toBe(false);
    expect(res.text).toMatch(/— \(unavailable right now; try \/alter connect \w+\)/);
    expect(res.text).toContain("https://connect.test");
    expect(res.text).not.toContain(INTERNAL);
    expect(logged(env.warn)).toContain("connect menu could not list connections");
    expect(logged(env.warn)).toMatch(/connect menu could not build a \w+ link: BackendError: internal/);
  });

  it("connections: an inactive identity says an administrator must act", async () => {
    const env = setup({
      listGrants: async () => {
        throw new PolicyViolationError(INTERNAL, "user_deprovisioned", {
          status_code: 403,
          error: "user_deprovisioned",
        });
      },
    });
    active = env;
    const res = await env.run("connections");
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      "Your Alter identity has been deprovisioned. An administrator must re-provision the account; " +
        "signing in again won't help.",
    );
    expect(res.text).not.toContain(INTERNAL);
  });

  it("connections revoke: generic reply naming the grant, error in the log only", async () => {
    const env = setup({ revokeGrant: async () => { throw new BackendError(INTERNAL, { status_code: 400 }); } });
    active = env;
    const res = await env.run("connections revoke g-123");
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      "Couldn't revoke g-123. Try again shortly; if it keeps failing, ask the operator to check the gateway log.",
    );
    expect(logged(env.warn)).toContain(`/alter could not revoke g-123: BackendError: ${INTERNAL}`);
  });
});
