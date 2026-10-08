import { afterEach, describe, expect, it } from "vitest";
import {
  makeToolHarness,
  AgentDelegationMissingError,
  AgentNotFoundError,
  BackendError,
  CredentialRevokedError,
  GrantDeletedError,
  GrantExpiredError,
  GrantNotFoundError,
  GrantRevokedError,
  NoDelegatedGrantError,
  PolicyViolationError,
  ProviderUnauthorizedError,
  ReAuthRequiredError,
  ScopeReauthRequiredError,
  type ToolHarness,
} from "./helpers/tool-harness.js";

/**
 * The reauth ladder: every terminal that means "the cached grant is dead"
 * must (1) drop the grant cache, (2) build a fresh connect URL, (3) emit an
 * info log, and (4) return an errResult carrying the reconnect line + a short
 * reason tag. These assert the OBSERVABLE contract against the real strings in
 * `tools/base.ts::execute` — substrings, cache state, and logger calls.
 */

let harness: ToolHarness;
afterEach(() => harness?.cleanup());

const RECONNECT_LINE = "Reconnect GitHub: https://connect.test/reconnect";

/** Common reauth-cluster assertions: cache dropped, connect URL built, info-logged, proxy called. */
async function expectReauth(h: ToolHarness, tagRegex: RegExp): Promise<string> {
  const res = await h.execute();
  const text = h.text(res);
  expect(res.isError).toBe(true);
  expect(text).toContain(RECONNECT_LINE);
  expect(text).toMatch(tagRegex);
  // Cache dropped so the next call re-probes.
  expect(h.grants.get(h.appUserId, "github")).toBeUndefined();
  expect(h.buildConnectUrl).toHaveBeenCalledTimes(1);
  expect(h.proxy).toHaveBeenCalledTimes(1);
  // Reauth path logs at info (NOT the generic BackendError warn).
  expect(h.logger.info).toHaveBeenCalledTimes(1);
  expect(h.logger.info.mock.calls[0]?.[0]).toContain("reauth required");
  return text;
}

describe("reauth ladder — typed terminals", () => {
  it("1. GrantExpiredError → tag 'expired'", async () => {
    harness = makeToolHarness({ proxy: async () => { throw new GrantExpiredError("grant ttl lapsed"); } });
    const text = await expectReauth(harness, /\(GitHub expired\. /);
    expect(harness.logger.info.mock.calls[0]?.[0]).toContain("GrantExpiredError");
  });

  it("2. CredentialRevokedError → tag 'revoked at provider'", async () => {
    harness = makeToolHarness({ proxy: async () => { throw new CredentialRevokedError("provider revoked app"); } });
    await expectReauth(harness, /\(GitHub revoked at provider\. /);
  });

  it("3. GrantDeletedError → tag 'disconnected in wallet'", async () => {
    harness = makeToolHarness({ proxy: async () => { throw new GrantDeletedError("user disconnected"); } });
    await expectReauth(harness, /\(GitHub disconnected in wallet\. /);
  });

  it("4. GrantRevokedError → tag 'revoked' (distinct from 'revoked at provider')", async () => {
    harness = makeToolHarness({ proxy: async () => { throw new GrantRevokedError("grant revoked"); } });
    const text = await expectReauth(harness, /\(GitHub revoked\. /);
    expect(text).not.toContain("revoked at provider");
  });

  it("5. NoDelegatedGrantError → tag 'delegation removed in wallet'", async () => {
    harness = makeToolHarness({ proxy: async () => { throw new NoDelegatedGrantError("no delegated grant"); } });
    await expectReauth(harness, /\(GitHub delegation removed in wallet\. /);
  });

  it("6. ScopeReauthRequiredError with missing scopes → 'missing scopes: repo, gist'", async () => {
    harness = makeToolHarness({
      proxy: async () => {
        throw new ScopeReauthRequiredError("scope drift", undefined, "github", 403, undefined, ["repo", "gist"]);
      },
    });
    await expectReauth(harness, /\(GitHub missing scopes: repo, gist\. /);
  });

  it("7. ScopeReauthRequiredError with empty scope list → 'missing required scopes'", async () => {
    harness = makeToolHarness({
      proxy: async () => {
        throw new ScopeReauthRequiredError("scope drift", undefined, "github", 403, undefined, []);
      },
    });
    const text = await expectReauth(harness, /\(GitHub missing required scopes\. /);
    expect(text).not.toContain("missing scopes:");
  });

  it("8. GrantNotFoundError → tag 'no longer linked'", async () => {
    harness = makeToolHarness({ proxy: async () => { throw new GrantNotFoundError("grant not found"); } });
    await expectReauth(harness, /\(GitHub no longer linked\. /);
  });

  it("9. ProviderUnauthorizedError → tag 'revoked at provider'", async () => {
    harness = makeToolHarness({
      proxy: async () => { throw new ProviderUnauthorizedError("provider 401", undefined, "github", 401); },
    });
    await expectReauth(harness, /\(GitHub revoked at provider\. /);
  });
});

describe("reauth ladder — subclasses and connect-URL failure", () => {
  it("10. AgentDelegationMissingError (the agent-path 404) → tag 'no longer linked'", async () => {
    // Agent.proxyRequest raises this subclass in place of GrantNotFoundError.
    harness = makeToolHarness({
      proxy: async () => {
        throw new AgentDelegationMissingError("grant not delegated to this agent", {
          status_code: 404,
          error: "grant_not_found",
        });
      },
    });
    await expectReauth(harness, /\(GitHub no longer linked\. /);
  });

  it("11. buildConnectUrl throws → '/alter connect' fallback line, cache STILL dropped", async () => {
    harness = makeToolHarness({
      proxy: async () => { throw new GrantExpiredError("expired"); },
      buildConnectUrl: async () => { throw new Error("connect endpoint down"); },
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("Reconnect with /alter connect github.");
    expect(text).toContain("GitHub expired.");
    // The URL-build failure does NOT prevent the cache drop (delete runs first).
    expect(harness.grants.get(harness.appUserId, "github")).toBeUndefined();
    expect(harness.buildConnectUrl).toHaveBeenCalledTimes(1);
  });
});

/**
 * Classification is by SDK error class only. There is no bare-status or
 * string-code fallback, so these lock in that errors which merely LOOK
 * grant-shaped (a 404, a 403) keep the grant and never send a reconnect link.
 * 12 and 13 are built the way the SDK really throws them for that wire
 * response; 14 guards against a status-based net creeping back.
 */
describe("reauth ladder — non-grant errors keep the grant", () => {
  it("12. AgentNotFoundError (404 caller_agent_unresolved) is NOT a reauth", async () => {
    // A key/agent misconfiguration. The old 404 net sent the user to reconnect,
    // which can't fix it.
    harness = makeToolHarness({
      proxy: async () => {
        throw new AgentNotFoundError({
          message: "caller does not name an active managed agent for this app",
          details: { status_code: 404, error: "caller_agent_unresolved" },
        });
      },
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("GitHub request failed and is not retryable");
    expect(text).not.toContain("Reconnect");
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
    expect(harness.buildConnectUrl).not.toHaveBeenCalled();
    expect(harness.logger.info).not.toHaveBeenCalled();
    expect(harness.logger.warn.mock.calls[0]?.[0]).toContain("status=404 code=caller_agent_unresolved");
  });

  it("13. a 403 with an untyped code arrives as PolicyViolationError → 'blocked by policy', cache NOT dropped", async () => {
    // The SDK's catch-all for 403 codes it doesn't type more narrowly.
    harness = makeToolHarness({
      proxy: async () => {
        throw new PolicyViolationError("forbidden by rule", "totally_unknown_code", {
          status_code: 403,
          error: "totally_unknown_code",
        });
      },
    });
    const res = await harness.execute();
    expect(res.isError).toBe(true);
    expect(harness.text(res)).toBe("Action blocked by policy: forbidden by rule");
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
    expect(harness.buildConnectUrl).not.toHaveBeenCalled();
    expect(harness.logger.info).not.toHaveBeenCalled();
  });

  it("14. an untyped BackendError is never a reauth, whatever its status", async () => {
    harness = makeToolHarness({
      proxy: async () => { throw new BackendError("gone", { status_code: 410 }); },
    });
    const res = await harness.execute();
    expect(harness.text(res)).toContain("GitHub request failed and is not retryable");
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
    expect(harness.buildConnectUrl).not.toHaveBeenCalled();
  });
});

describe("reauth ladder — plain ReAuthRequiredError fallback", () => {
  it("19. a ReAuthRequiredError that isn't a rejected sign-in → tag 'connection no longer valid'", async () => {
    // Guards the ladder's catch-all for a future ReAuthRequiredError subclass or
    // code: it must still read as a dead grant, not fall through to the
    // generic BackendError branch.
    harness = makeToolHarness({
      proxy: async () => {
        throw new ReAuthRequiredError("re-authorization required", {
          status_code: 403,
          error: "some_future_reauth_code",
        });
      },
    });
    await expectReauth(harness, /\(GitHub connection no longer valid\. /);
    expect(harness.startLogin).not.toHaveBeenCalled();
  });
});

/** What the SDK throws for the backend's 401 `jwt_validation_error`. */
function tokenRejected(): ReAuthRequiredError {
  return new ReAuthRequiredError("JWT validation failed: Signature has expired", {
    status_code: 401,
    error: "jwt_validation_error",
  });
}

/**
 * Alter rejecting the user's sign-in JWT is a plain ReAuthRequiredError, the
 * parent of the grant terminals. Read as a dead grant, it used to drop the cache
 * and send a reconnect link, which can't work: the connect flow runs under the
 * same rejected token. It must send a fresh sign-in instead, wherever the token
 * is presented.
 */
describe("rejected sign-in token → fresh sign-in, never a reconnect", () => {
  function expectSignIn(h: ToolHarness, text: string): void {
    expect(text).toContain("Alter rejected your sign-in, so you need to sign in again.");
    expect(text).toContain("Click here: https://login.test/start");
    expect(text).not.toContain("Reconnect");
    expect(h.startLogin).toHaveBeenCalledWith("slack", "U123", h.sessionId);
    // Warn with the backend's validation reason, so an iss/aud mismatch that
    // rejects every fresh token is visible to the operator.
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    const warn = h.logger.warn.mock.calls[0]?.[0] as string;
    expect(warn).toContain("sign-in token rejected by Alter");
    expect(warn).toContain("Signature has expired");
  }

  it("15. on the proxied call: sign-in link, grant cache KEPT, no reauth line", async () => {
    harness = makeToolHarness({ proxy: async () => { throw tokenRejected(); } });
    const res = await harness.execute();
    expect(res.isError).toBe(false);
    expectSignIn(harness, harness.text(res));
    // The grant is fine; only the token is bad.
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
    expect(harness.buildConnectUrl).not.toHaveBeenCalled();
    expect(harness.logger.info).not.toHaveBeenCalled();
  });

  it("16. on the cache-miss grant probe: sign-in link, no connect link, no proxy call", async () => {
    harness = makeToolHarness({
      seedGrantId: null,
      listGrants: async () => { throw tokenRejected(); },
    });
    const res = await harness.execute();
    expect(res.isError).toBe(false);
    expectSignIn(harness, harness.text(res));
    expect(harness.buildConnectUrl).not.toHaveBeenCalled();
    expect(harness.proxy).not.toHaveBeenCalled();
  });

  it("17. on minting the connect session: sign-in link instead of an unhandled throw", async () => {
    harness = makeToolHarness({
      seedGrantId: null,
      listGrants: async () => ({ grants: [], total: 0, hasMore: false, limit: 100, offset: 0 }),
      buildConnectUrl: async () => { throw tokenRejected(); },
    });
    const res = await harness.execute();
    expect(res.isError).toBe(false);
    expectSignIn(harness, harness.text(res));
    expect(harness.proxy).not.toHaveBeenCalled();
  });

  it("18. any other connect-session failure still propagates", async () => {
    harness = makeToolHarness({
      seedGrantId: null,
      listGrants: async () => ({ grants: [], total: 0, hasMore: false, limit: 100, offset: 0 }),
      buildConnectUrl: async () => { throw new Error("connect endpoint down"); },
    });
    await expect(harness.execute()).rejects.toThrow("connect endpoint down");
    expect(harness.startLogin).not.toHaveBeenCalled();
  });
});
