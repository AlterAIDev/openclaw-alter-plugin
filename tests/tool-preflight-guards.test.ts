import { afterEach, describe, expect, it } from "vitest";
import { makeToolHarness, oauthGrantRow, type ToolHarness } from "./helpers/tool-harness.js";

/**
 * Pre-proxy guards, in the order `execute` runs them: channel attachment →
 * pending lock (covered in the approval-flow file) → identity link → jwt
 * expiry → quota cap → grant resolution (cache hit / listGrants probe) →
 * param validation. Each guard short-circuits before `proxyRequest`, so the
 * proxy spy staying at zero calls is the load-bearing assertion.
 */

let harness: ToolHarness;
afterEach(() => harness?.cleanup());

describe("preflight guards", () => {
  it("1. channel guard — missing sessionId returns a channel-attached error, no proxy", async () => {
    harness = makeToolHarness({ ctx: { sessionId: null } });
    const res = await harness.execute();
    expect(res.isError).toBe(true);
    expect(harness.text(res)).toContain("requires a channel-attached chat session");
    expect(harness.proxy).not.toHaveBeenCalled();
  });

  it("2. no identity link → start-login URL as a SUCCESS result, no proxy", async () => {
    harness = makeToolHarness({ identityLink: null });
    const res = await harness.execute();
    const text = harness.text(res);
    // Sign-in link is the actionable next step — surfaced as okResult, not an error.
    expect(res.isError).toBe(false);
    expect(text).toContain("You need to sign in once before I can help.");
    expect(text).toContain("https://login.test/start");
    expect(harness.startLogin).toHaveBeenCalledTimes(1);
    expect(harness.proxy).not.toHaveBeenCalled();
  });

  it("3. expired jwt → re-link URL, no proxy", async () => {
    harness = makeToolHarness({ identityLink: { jwtExpiresAt: Date.now() - 1000 } });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(false);
    expect(text).toContain("Your sign-in expired. Click here: https://login.test/start");
    expect(harness.startLogin).toHaveBeenCalledTimes(1);
    expect(harness.proxy).not.toHaveBeenCalled();
  });

  it("4. over-quota → usage-cap error, no proxy", async () => {
    harness = makeToolHarness({ overQuota: true });
    const res = await harness.execute();
    expect(res.isError).toBe(true);
    expect(harness.text(res)).toContain("You've reached today's usage cap.");
    expect(harness.proxy).not.toHaveBeenCalled();
  });

  it("5. TypeBox-invalid params → validation error, toProxyArgs and proxy skipped", async () => {
    // `{}` omits the required `q` — Value.Check must reject before toProxyArgs.
    harness = makeToolHarness({ params: {} });
    const res = await harness.execute();
    expect(res.isError).toBe(true);
    expect(harness.text(res)).toContain("Invalid arguments to alter_test_tool");
    expect(harness.toProxyArgs).not.toHaveBeenCalled();
    expect(harness.proxy).not.toHaveBeenCalled();
  });

  it("6. cache-miss probe — finds+caches a delegation, then proxies; empty probe → connect URL", async () => {
    // 6a: listGrants surfaces an active delegation → probe upserts it and proxies with it.
    const hit = makeToolHarness({
      seedGrantId: null,
      listGrants: async (args) => ({
        grants: [oauthGrantRow({ grantId: "probed-grant", providerId: "github" })],
        total: 1,
        hasMore: false,
        limit: args.limit,
        offset: args.offset ?? 0,
      }),
      proxy: async () => {
        // Return a synchronous 200 body so execute reaches okResult.
        const { ApprovalResult } = await import("@alter-ai/alter-sdk");
        return new ApprovalResult({
          status_code: 200,
          headers: {},
          body_b64: Buffer.from(JSON.stringify({ ok: true })).toString("base64"),
        });
      },
    });
    try {
      const res = await hit.execute();
      expect(res.isError).toBe(false);
      // The probed grant id was cached...
      expect(hit.grants.get(hit.appUserId, "github")).toBe("probed-grant");
      // ...and used for the proxied call.
      expect(hit.proxy).toHaveBeenCalledTimes(1);
      expect((hit.proxy.mock.calls[0]?.[0] as { grantId?: string })?.grantId).toBe("probed-grant");
      // The probe response is info-logged for operator triage.
      expect(hit.logger.info.mock.calls.some((c) => String(c[0]).includes("agent-delegation probe response"))).toBe(true);
      // The probe is scoped to THIS provider + THIS user (a cross-tenant edge):
      // listGrants must receive providerId AND the user's endUserToken. If
      // either were dropped, the agent could resolve another provider or another
      // user's delegation.
      const probeArg = hit.listGrants.mock.calls[0]?.[0] as {
        providerId?: string;
        endUserToken?: string;
      };
      expect(probeArg.providerId).toBe("github");
      expect(probeArg.endUserToken).toBe("test.jwt.token");
    } finally {
      hit.cleanup();
    }

    // 6b: empty probe → no grant → the connect prompt (not a proxy call).
    harness = makeToolHarness({
      seedGrantId: null,
      listGrants: async (args) => ({
        grants: [],
        total: 0,
        hasMore: false,
        limit: args.limit,
        offset: args.offset ?? 0,
      }),
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(false);
    expect(text).toContain("You haven't connected GitHub yet.");
    expect(text).toContain("https://connect.test/reconnect");
    expect(harness.proxy).not.toHaveBeenCalled();
    expect(harness.buildConnectUrl).toHaveBeenCalledTimes(1);
  });
});
