import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { App } from "@alter-ai/alter-sdk";
import type {
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { registerCommands, type CommandsDeps } from "../src/commands.js";
import { GrantsStore } from "../src/grants/store.js";
import { IdentityStore } from "../src/identity/store.js";
import type { GrantItem } from "../src/grants/grant-query.js";
import { closeDatabase } from "../src/sqlite.js";

/**
 * `/alter connections revoke <id>` revokes a USER base grant via
 * `app.revokeGrant`, which cascade-kills the agent delegation hanging off it.
 * The local delegation cache stores agent-delegation ids keyed by PROVIDER
 * (never base-grant ids), so eviction must resolve the target's provider from
 * the listed grants and delete BY THAT PROVIDER — a blind grantId match would
 * never hit. These tests pin that eviction contract.
 */

const CHANNEL = "slack";
const CHANNEL_USER = "U555";
const APP_USER = "idp:revokeuser";

function baseGrant(p: { grantId: string; providerId: string; status?: string }): GrantItem {
  return {
    grantKind: "oauth",
    grantId: p.grantId,
    providerId: p.providerId,
    principalType: "user",
    status: p.status ?? "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as GrantItem;
}

function setup(opts: {
  listed: GrantItem[];
  revokeResult?: { success: boolean; message?: string };
}): {
  grants: GrantsStore;
  revokeGrant: ReturnType<typeof vi.fn>;
  run: (args: string) => Promise<PluginCommandResult>;
  cleanup: () => void;
} {
  const tmp = mkdtempSync(join(tmpdir(), "alter-revoke-"));
  const grants = new GrantsStore(tmp);
  const identities = new IdentityStore(tmp, randomBytes(32));

  identities.upsert({
    channelKind: CHANNEL,
    channelUserId: CHANNEL_USER,
    appUserId: APP_USER,
    idpSub: "revokeuser",
    jwt: "revoke.jwt.token",
    jwtExpiresAt: Date.now() + 60 * 60 * 1000,
  });

  const revokeGrant = vi.fn(
    async () => opts.revokeResult ?? { success: true, message: "operator-only internal detail" },
  );
  const app = {
    listGrants: async (args: { limit: number; offset: number }) => ({
      grants: opts.listed,
      hasMore: false,
      total: opts.listed.length,
      limit: args.limit,
      offset: args.offset,
    }),
    revokeGrant,
  } as unknown as App;

  const deps = { app, identities, grants } as unknown as CommandsDeps;

  let handler:
    | ((ctx: PluginCommandContext) => Promise<PluginCommandResult>)
    | undefined;
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerCommand: (cmd: {
      handler: (ctx: PluginCommandContext) => Promise<PluginCommandResult>;
    }): void => {
      handler = cmd.handler;
    },
  } as unknown as Parameters<typeof registerCommands>[0];

  registerCommands(api, deps);
  if (!handler) throw new Error("alter command not registered");

  const run = (args: string): Promise<PluginCommandResult> =>
    handler!({
      channel: CHANNEL,
      senderId: CHANNEL_USER,
      sessionId: "sess-revoke",
      args,
    } as unknown as PluginCommandContext);

  return {
    grants,
    revokeGrant,
    run,
    cleanup: () => {
      closeDatabase();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

let active: { cleanup: () => void } | undefined;
afterEach(() => active?.cleanup());

describe("/alter connections revoke", () => {
  it("evicts the delegation cache BY the target's provider on a successful revoke", async () => {
    const env = setup({ listed: [baseGrant({ grantId: "base-grant-1", providerId: "github" })] });
    active = env;
    // Cache holds the agent DELEGATION id (not the base grant id), keyed by provider.
    env.grants.upsert(APP_USER, "github", "delegation-xyz");
    expect(env.grants.get(APP_USER, "github")).toBe("delegation-xyz");

    const res = await env.run("connections revoke base-grant-1");

    expect(env.revokeGrant).toHaveBeenCalledTimes(1);
    expect(env.revokeGrant.mock.calls[0]?.[0]).toBe("base-grant-1");
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain("Revoked grant base-grant-1");
    expect(res.text).toContain("success: true");
    // The backend/SDK message is NOT echoed to the user (operator-log only).
    expect(res.text).not.toContain("operator-only internal detail");
    // Cache evicted by the target's provider, so the next tool call re-probes.
    expect(env.grants.get(APP_USER, "github")).toBeUndefined();
  });

  it("leaves the cache intact when the revoke handle matches none of the user's grants", async () => {
    const env = setup({ listed: [baseGrant({ grantId: "base-grant-1", providerId: "github" })] });
    active = env;
    env.grants.upsert(APP_USER, "github", "delegation-xyz");

    // A handle the user doesn't own → no target resolved → no provider to evict.
    await env.run("connections revoke some-other-id");

    // revokeGrant is still attempted (backend is the authority), but eviction
    // is provider-scoped and there was no matching target, so the cache stays.
    expect(env.grants.get(APP_USER, "github")).toBe("delegation-xyz");
  });
});
