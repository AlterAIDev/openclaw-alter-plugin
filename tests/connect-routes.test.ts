import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Agent } from "@alter-ai/alter-sdk";
import {
  registerConnectRoutes,
  newConnectStatePayload,
} from "../src/grants/connect-routes.js";
import type { AlterPluginConfig } from "../src/config.js";
import { GrantsStore } from "../src/grants/store.js";
import { PendingConnectsStore } from "../src/grants/pending-connects.js";
import { IdentityStore } from "../src/identity/store.js";
import { StateHmac, newCsrfNonce } from "../src/grants/state-hmac.js";
import type { GrantItem } from "../src/grants/grant-query.js";
import { closeDatabase } from "../src/sqlite.js";

/**
 * The /alter/connect/cb handler correlates a just-completed OAuth flow to the
 * agent's delegation. It prefers the delegation minted DURING this session
 * (`createdSinceIso`), but the Connect fast-path REUSES an existing delegation
 * when the user already had a credential — that row predates the session, so
 * the since-filter drops it. The regression these tests pin: an already-
 * connected reconnect must NOT 404 (it must fall back to the newest active
 * delegation and cache it); a genuine no-delegation case must still 404.
 */

const CHANNEL = "slack";
const CHANNEL_USER = "U777";
const APP_USER = "idp:connectuser";
const PROVIDER = "github";

function oauthRow(p: { grantId: string; status?: string; createdAt?: string }): GrantItem {
  return {
    grantKind: "oauth",
    grantId: p.grantId,
    providerId: PROVIDER,
    principalType: "agent",
    status: p.status ?? "active",
    createdAt: p.createdAt ?? "2026-01-01T00:00:00.000Z",
  } as unknown as GrantItem;
}

interface FakeRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  setHeader(k: string, v: string): void;
  end(chunk?: string): void;
}

function makeRes(): FakeRes {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(chunk?: string) {
      if (chunk !== undefined) this.body = chunk;
    },
  };
}

/**
 * Seed identity + pending-connect rows, register the route, and return a driver
 * that fires the callback against an agent whose listGrants yields `rows`.
 */
function setup(rows: GrantItem[]): {
  grants: GrantsStore;
  fire: () => Promise<{ res: FakeRes; handled: boolean }>;
  cleanup: () => void;
} {
  const tmp = mkdtempSync(join(tmpdir(), "alter-connect-"));
  const identityKey = randomBytes(32);
  const grants = new GrantsStore(tmp);
  const pending = new PendingConnectsStore(tmp);
  const identities = new IdentityStore(tmp, identityKey);
  const stateHmac = new StateHmac(randomBytes(32));

  identities.upsert({
    channelKind: CHANNEL,
    channelUserId: CHANNEL_USER,
    appUserId: APP_USER,
    idpSub: "connectuser",
    jwt: "connect.jwt.token",
    jwtExpiresAt: Date.now() + 60 * 60 * 1000,
  });

  const csrfNonce = newCsrfNonce();
  const payload = newConnectStatePayload({
    csrfNonce,
    sessionId: "sess-connect",
    channelKind: CHANNEL,
    channelUserId: CHANNEL_USER,
    appUserId: APP_USER,
    provider: PROVIDER,
  });
  const stateToken = stateHmac.sign(payload);
  pending.insert({
    csrfNonce,
    sessionId: "sess-connect",
    appUserId: APP_USER,
    provider: PROVIDER,
    iatMs: payload.iatMs,
    ttlMs: payload.ttlMs,
  });

  const agent = {
    listGrants: async (args: { limit: number; offset: number }) => ({
      grants: rows,
      hasMore: false,
      total: rows.length,
      limit: args.limit,
      offset: args.offset,
    }),
  } as unknown as Agent;

  const cfg = { publicBaseUrl: "https://plugin.test" } as unknown as AlterPluginConfig;

  let handler:
    | ((req: IncomingMessage, res: ServerResponse) => Promise<boolean>)
    | undefined;
  const api = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerHttpRoute: (route: {
      handler: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
    }): void => {
      handler = route.handler;
    },
  } as unknown as Parameters<typeof registerConnectRoutes>[0];

  registerConnectRoutes(api, { cfg, agent, grants, pending, identities, stateHmac });
  if (!handler) throw new Error("connect route not registered");

  const fire = async (): Promise<{ res: FakeRes; handled: boolean }> => {
    const req = {
      url: `/alter/connect/cb?state=${encodeURIComponent(stateToken)}`,
      socket: { remoteAddress: "203.0.113.7" },
    } as unknown as IncomingMessage;
    const res = makeRes();
    const handled = await handler!(req, res as unknown as ServerResponse);
    return { res, handled };
  };

  return {
    grants,
    fire,
    cleanup: () => {
      closeDatabase();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

let active: { cleanup: () => void } | undefined;
afterEach(() => active?.cleanup());

describe("/alter/connect/cb grant correlation", () => {
  it("reconnect of an already-connected account (older delegation) is selected + cached, not 404'd", async () => {
    // The active delegation predates this connect session (fast-path reuse), so
    // it fails the createdSinceIso filter — the fallback must still pick it.
    const env = setup([oauthRow({ grantId: "reused-delegation", createdAt: "2020-01-01T00:00:00.000Z" })]);
    active = env;
    const { res } = await env.fire();
    expect(res.statusCode).toBe(200);
    // The reused delegation was cached despite predating the session window.
    expect(env.grants.get(APP_USER, PROVIDER)).toBe("reused-delegation");
  });

  it("still 404s when there is genuinely no active delegation (only a revoked one)", async () => {
    const env = setup([
      oauthRow({ grantId: "dead-delegation", status: "revoked", createdAt: "2026-06-01T00:00:00.000Z" }),
    ]);
    active = env;
    const { res } = await env.fire();
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain("No matching grant");
    // Nothing cached — a revoked delegation reads as "not connected".
    expect(env.grants.get(APP_USER, PROVIDER)).toBeUndefined();
  });

  it("still 404s when listGrants returns no rows at all", async () => {
    const env = setup([]);
    active = env;
    const { res } = await env.fire();
    expect(res.statusCode).toBe(404);
    expect(env.grants.get(APP_USER, PROVIDER)).toBeUndefined();
  });
});
