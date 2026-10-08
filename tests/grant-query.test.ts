import { describe, expect, it } from "vitest";
import type { Agent, App } from "@alter-ai/alter-sdk";
import {
  listAllAgentGrants,
  listAllGrants,
  selectActiveAgentOAuthGrant,
  type GrantItem,
} from "../src/grants/grant-query.js";

/**
 * Build an OAuth grant row (duck-typed to the SDK union for tests). These
 * model rows from the AGENT's delegated view (`Agent.listGrants`), so the
 * default `principalType` is "agent".
 */
function oauth(p: {
  grantId: string;
  providerId?: string;
  principalType?: string;
  status?: string;
  createdAt?: string;
}): GrantItem {
  return {
    grantKind: "oauth",
    grantId: p.grantId,
    providerId: p.providerId ?? "google",
    principalType: p.principalType ?? "agent",
    status: p.status ?? "active",
    createdAt: p.createdAt ?? "2026-01-01T00:00:00.000Z",
  } as unknown as GrantItem;
}

/** Build a managed-secret grant row. */
function managed(p: { grantId: string; status?: string }): GrantItem {
  return {
    grantKind: "managed_secret",
    grantId: p.grantId,
    managedSecretSlug: "stripe-key",
    principalType: "agent",
    status: p.status ?? "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as unknown as GrantItem;
}

/** Agent stub exposing only listGrants, driven by a per-offset page function. */
function makeAgent(
  pages: (args: {
    providerId?: string;
    endUserToken?: string;
    limit: number;
    offset: number;
  }) => {
    grants: GrantItem[];
    hasMore: boolean;
  },
): Agent {
  return {
    listGrants: async (args: {
      providerId?: string;
      endUserToken?: string;
      limit: number;
      offset: number;
    }) => {
      const { grants, hasMore } = pages(args);
      return { grants, hasMore, total: grants.length, limit: args.limit, offset: args.offset };
    },
  } as unknown as Agent;
}

/** App stub exposing only listGrants, driven by a per-offset page function. */
function makeApp(
  pages: (args: { providerId?: string; limit: number; offset: number }) => {
    grants: GrantItem[];
    hasMore: boolean;
  },
): App {
  return {
    listGrants: async (args: { providerId?: string; limit: number; offset: number }) => {
      const { grants, hasMore } = pages(args);
      return { grants, hasMore, total: grants.length, limit: args.limit, offset: args.offset };
    },
  } as unknown as App;
}

describe("selectActiveAgentOAuthGrant", () => {
  it("ignores revoked/expired delegations (the wallet-revoke safety net)", () => {
    const grants = [
      oauth({ grantId: "g_revoked", status: "revoked", createdAt: "2026-06-01T00:00:00.000Z" }),
      oauth({ grantId: "g_expired", status: "expired", createdAt: "2026-06-02T00:00:00.000Z" }),
    ];
    // Even though these are the newest rows for the provider, none are active,
    // so the result is "not connected" → caller re-runs connect.
    expect(selectActiveAgentOAuthGrant(grants, { provider: "google" })).toBeUndefined();
  });

  it("picks the newest ACTIVE delegation, skipping a newer revoked one", () => {
    const grants = [
      oauth({ grantId: "g_old_active", status: "active", createdAt: "2026-06-01T00:00:00.000Z" }),
      oauth({ grantId: "g_new_revoked", status: "revoked", createdAt: "2026-06-09T00:00:00.000Z" }),
    ];
    expect(selectActiveAgentOAuthGrant(grants, { provider: "google" })?.grantId).toBe("g_old_active");
  });

  it("picks the newest among multiple active delegations", () => {
    const grants = [
      oauth({ grantId: "g1", createdAt: "2026-06-01T00:00:00.000Z" }),
      oauth({ grantId: "g3", createdAt: "2026-06-09T00:00:00.000Z" }),
      oauth({ grantId: "g2", createdAt: "2026-06-05T00:00:00.000Z" }),
    ];
    expect(selectActiveAgentOAuthGrant(grants, { provider: "google" })?.grantId).toBe("g3");
  });

  it("filters by provider + grantKind=oauth WITHOUT dropping agent-principal rows", () => {
    // Regression guard: the old `selectActiveUserOAuthGrant` filtered
    // `principalType === "user"`, which dropped the agent's own delegation
    // (principal_type="agent") — the exact bug that caused the 404 loop. The
    // agent-delegated view is already scoped to usable edges, so we must NOT
    // re-filter on principalType.
    const grants = [
      oauth({ grantId: "wrong_provider", providerId: "github" }),
      managed({ grantId: "managed_secret_row" }),
      oauth({ grantId: "right", providerId: "google", principalType: "agent" }),
    ];
    expect(selectActiveAgentOAuthGrant(grants, { provider: "google" })?.grantId).toBe("right");
  });

  it("honors createdSinceIso — excludes delegations created before the window", () => {
    const grants = [
      oauth({ grantId: "g_before", createdAt: "2026-06-01T00:00:00.000Z" }),
      oauth({ grantId: "g_after", createdAt: "2026-06-10T00:00:00.000Z" }),
    ];
    const since = "2026-06-05T00:00:00.000Z";
    expect(
      selectActiveAgentOAuthGrant(grants, { provider: "google", createdSinceIso: since })?.grantId,
    ).toBe("g_after");
  });

  it("returns undefined when createdSinceIso excludes everything", () => {
    const grants = [oauth({ grantId: "g_before", createdAt: "2026-06-01T00:00:00.000Z" })];
    expect(
      selectActiveAgentOAuthGrant(grants, {
        provider: "google",
        createdSinceIso: "2026-06-05T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });
});

describe("listAllAgentGrants", () => {
  it("accumulates pages until hasMore is false", async () => {
    const agent = makeAgent(({ offset }) => {
      if (offset === 0) return { grants: [oauth({ grantId: "a" })], hasMore: true };
      if (offset === 100) return { grants: [oauth({ grantId: "b" })], hasMore: true };
      return { grants: [oauth({ grantId: "c" })], hasMore: false };
    });
    const out = await listAllAgentGrants(agent, { endUserToken: "jwt" });
    expect(out.map((g) => g.grantKind === "oauth" && g.grantId)).toEqual(["a", "b", "c"]);
  });

  it("stops at maxPages even if hasMore stays true", async () => {
    let calls = 0;
    const agent = makeAgent(() => {
      calls++;
      return { grants: [oauth({ grantId: `g${calls}` })], hasMore: true };
    });
    const out = await listAllAgentGrants(agent, {
      endUserToken: "jwt",
      maxPages: 3,
      pageSize: 100,
    });
    expect(calls).toBe(3);
    expect(out).toHaveLength(3);
  });

  it("forwards providerId and endUserToken to listGrants", async () => {
    const seen: Array<{ providerId?: string; endUserToken?: string }> = [];
    const agent = makeAgent((args) => {
      seen.push({ providerId: args.providerId, endUserToken: args.endUserToken });
      return { grants: [], hasMore: false };
    });
    await listAllAgentGrants(agent, { providerId: "slack", endUserToken: "jwt-xyz" });
    expect(seen).toEqual([{ providerId: "slack", endUserToken: "jwt-xyz" }]);
  });
});

describe("listAllGrants (App view — used by /alter connections management)", () => {
  it("accumulates pages until hasMore is false", async () => {
    const app = makeApp(({ offset }) => {
      if (offset === 0) return { grants: [oauth({ grantId: "a" })], hasMore: true };
      if (offset === 100) return { grants: [oauth({ grantId: "b" })], hasMore: true };
      return { grants: [oauth({ grantId: "c" })], hasMore: false };
    });
    const out = await listAllGrants(app);
    expect(out.map((g) => g.grantKind === "oauth" && g.grantId)).toEqual(["a", "b", "c"]);
  });

  it("stops at maxPages even if hasMore stays true", async () => {
    let calls = 0;
    const app = makeApp(() => {
      calls++;
      return { grants: [oauth({ grantId: `g${calls}` })], hasMore: true };
    });
    const out = await listAllGrants(app, { maxPages: 3, pageSize: 100 });
    expect(calls).toBe(3);
    expect(out).toHaveLength(3);
  });

  it("forwards providerId to listGrants", async () => {
    const seen: Array<string | undefined> = [];
    const app = makeApp((args) => {
      seen.push(args.providerId);
      return { grants: [], hasMore: false };
    });
    await listAllGrants(app, { providerId: "slack" });
    expect(seen).toEqual(["slack"]);
  });
});
