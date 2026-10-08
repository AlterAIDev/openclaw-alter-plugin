import { afterEach, describe, expect, it } from "vitest";
import {
  makeToolHarness,
  AlterValueError,
  BackendError,
  InsufficientScopeError,
  InvalidKeyError,
  PolicyViolationError,
  QuotaExceededError,
  RateLimitError,
  StepUpRequiredError,
  TokenRefreshInProgressError,
  type ToolHarness,
} from "./helpers/tool-harness.js";
import { LoginRateLimitedError } from "../src/identity/login-rate-limit.js";

/**
 * Non-reauth error mapping: policy denials, value errors, identity
 * deprovision, transient vs terminal BackendError classification, and the
 * unknown-error re-throw. These assert the exact user-facing strings AND that
 * only grant-gone terminals drop the cache (everything here keeps it).
 */

let harness: ToolHarness;
afterEach(() => harness?.cleanup());

describe("error mapping — non-reauth terminals", () => {
  it("1. PolicyViolationError → 'Action blocked by policy', cache NOT dropped", async () => {
    harness = makeToolHarness({
      proxy: async () => { throw new PolicyViolationError("outside business hours"); },
    });
    const res = await harness.execute();
    expect(res.isError).toBe(true);
    expect(harness.text(res)).toBe("Action blocked by policy: outside business hours");
    // Policy denial may resolve on its own — the grant is fine, keep the cache.
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
    expect(harness.buildConnectUrl).not.toHaveBeenCalled();
  });

  it("2. AlterValueError → 'Invalid request to <provider>', cache NOT dropped", async () => {
    harness = makeToolHarness({
      proxy: async () => { throw new AlterValueError("q must be non-empty"); },
    });
    const res = await harness.execute();
    expect(res.isError).toBe(true);
    expect(harness.text(res)).toBe("Invalid request to github: q must be non-empty");
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
  });

  it("3. 403 user_deprovisioned → identity terminal, NOT 'blocked by policy'", async () => {
    // The SDK surfaces this 403 as a PolicyViolationError (its catch-all for
    // 403 codes it doesn't type), so it must be caught before the generic
    // policy branch. A raw BackendError here would test a shape the SDK never
    // throws, which is how this branch went dead unnoticed.
    harness = makeToolHarness({
      proxy: async () => {
        throw new PolicyViolationError(
          "User has been deprovisioned from identity provider",
          "user_deprovisioned",
          { status_code: 403, error: "user_deprovisioned" },
        );
      },
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("Your Alter identity has been deprovisioned");
    expect(text).toContain("an administrator must re-provision");
    expect(text).toContain("do NOT suggest reconnecting");
    expect(text).not.toContain("blocked by policy");
    // Deprovision is an identity terminal, not a grant terminal — cache stays.
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
    expect(harness.buildConnectUrl).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledTimes(1);
    expect(harness.logger.warn.mock.calls[0]?.[0]).toContain("identity deprovisioned");
  });

  it("4. 403 user_suspended → identity terminal asking for reactivation", async () => {
    harness = makeToolHarness({
      proxy: async () => {
        throw new PolicyViolationError(
          "User has been suspended in identity provider",
          "user_suspended",
          { status_code: 403, error: "user_suspended" },
        );
      },
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("Your Alter identity has been suspended");
    expect(text).toContain("an administrator must reactivate");
    expect(text).not.toContain("blocked by policy");
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
  });

  it("5. transient BackendError (no status / 5xx) → 'please retry'", async () => {
    // Variant A: no status surfaced (network-shaped) → treated as transient.
    const h1 = makeToolHarness({
      proxy: async () => { throw new BackendError("connection reset by peer"); },
    });
    try {
      const r1 = await h1.execute();
      expect(r1.isError).toBe(true);
      expect(h1.text(r1)).toBe("Temporary failure calling GitHub; please retry.");
      expect(h1.grants.get(h1.appUserId, "github")).toBe("grant-test-1");
    } finally {
      h1.cleanup();
    }
    // Variant B: an explicit 503.
    harness = makeToolHarness({
      proxy: async () => { throw new BackendError("upstream unavailable", { status_code: 503 }); },
    });
    const r2 = await harness.execute();
    expect(r2.isError).toBe(true);
    expect(harness.text(r2)).toBe("Temporary failure calling GitHub; please retry.");
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
  });

  it("6. terminal 4xx BackendError (422) → 'not retryable', cache NOT dropped", async () => {
    harness = makeToolHarness({
      proxy: async () => {
        throw new BackendError("unprocessable entity", { status_code: 422, error: "validation_failed" });
      },
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("GitHub request failed and is not retryable");
    // The raw BackendError message is NOT echoed to the user (it can carry
    // SDK/backend internal detail) — only the generic non-retryable signal.
    expect(text).not.toContain("unprocessable entity");
    // ...but the detail IS preserved in the operator-visible warn log.
    expect(harness.logger.warn).toHaveBeenCalledTimes(1);
    expect(harness.logger.warn.mock.calls[0]?.[0]).toContain("unprocessable entity");
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
  });

  it("7. unknown error (TypeError) → re-thrown to the runtime + logged", async () => {
    harness = makeToolHarness({
      proxy: async () => { throw new TypeError("cannot read property 'x' of undefined"); },
    });
    await expect(harness.execute()).rejects.toThrow("cannot read property 'x' of undefined");
    expect(harness.logger.warn).toHaveBeenCalledTimes(1);
    const warn = harness.logger.warn.mock.calls[0]?.[0] as string;
    expect(warn).toContain("unhandled error");
    expect(warn).toContain("TypeError");
    // The unknown path does NOT drop the cache — it can't classify the failure.
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
  });

  it("8. StepUpRequiredError → fresh sign-in link (not a dead-end policy block), cache NOT dropped", async () => {
    // A PolicyViolationError subclass, so without its own branch it would read
    // "Action blocked by policy", which the user has no way to act on.
    harness = makeToolHarness({
      proxy: async () => {
        throw new StepUpRequiredError("requires a fresh end-user authentication", 300, {
          status_code: 403,
          error: "step_up_required",
        });
      },
    });
    const res = await harness.execute();
    const text = harness.text(res);
    // The link is the actionable next step, so it's a successful result (same
    // posture as the expired-sign-in path).
    expect(res.isError).toBe(false);
    expect(text).toContain("This action needs a fresh sign-in");
    expect(text).toContain("Click here: https://login.test/start");
    expect(text).not.toContain("blocked by policy");
    expect(harness.startLogin).toHaveBeenCalledWith("slack", "U123", harness.sessionId);
    // The grant is fine — only the session is too old.
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
    expect(harness.buildConnectUrl).not.toHaveBeenCalled();
    const logged = harness.logger.info.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("step-up sign-in required");
    expect(logged).toContain("maxSessionAgeSeconds=300");
  });

  it("9. StepUpRequiredError while sign-in is rate-limited → the rate-limit message", async () => {
    harness = makeToolHarness({
      proxy: async () => { throw new StepUpRequiredError("stale session"); },
      startLogin: async () => { throw new LoginRateLimitedError(42); },
    });
    const res = await harness.execute();
    expect(res.isError).toBe(true);
    expect(harness.text(res)).toBe("Too many sign-in attempts. Try again in ~42s.");
  });

  it("10. RateLimitError (Alter's limiter) → retry-later with the server's wait, NOT 'not retryable'", async () => {
    harness = makeToolHarness({
      proxy: async () => {
        throw new RateLimitError(
          "Rate limit exceeded",
          30,
          { status_code: 429, error: "rate_limit_exceeded" },
          "api_key",
          600,
          60,
        );
      },
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toBe(
      "Alter is rate-limiting requests right now. Tell the user to try GitHub again in about 30s.",
    );
    expect(text).not.toContain("not retryable");
    const warn = harness.logger.warn.mock.calls[0]?.[0] as string;
    expect(warn).toContain("RateLimitError");
    expect(warn).toContain("scope=api_key limit=600/60s");
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
  });

  it("11. QuotaExceededError (policy quota) → 'resets in about N' with a humanized long window", async () => {
    harness = makeToolHarness({
      proxy: async () => {
        throw new QuotaExceededError("Request quota exceeded", 3 * 86_400, {
          status_code: 429,
          error: "quota_exceeded",
        });
      },
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("GitHub has used up the request quota your Alter policy allows");
    expect(text).toContain("resets in about 3 days");
    expect(text).toContain("do not retry before then");
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
  });

  it("12. key-liveness 401 (InvalidKeyError) → generic user text, backend hint in the operator log", async () => {
    const hint = "Keys created before the September 2026 key-security upgrade must be replaced.";
    harness = makeToolHarness({
      proxy: async () => {
        throw new InvalidKeyError({
          message: "Invalid API key",
          details: { status_code: 401, error: "invalid_key" },
          hint,
        });
      },
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("GitHub request failed and is not retryable");
    // The hint is operator guidance, not user text.
    expect(text).not.toContain("September 2026");
    const warn = harness.logger.warn.mock.calls[0]?.[0] as string;
    expect(warn).toContain("code=invalid_key");
    expect(warn).toContain(`hint=${JSON.stringify(hint)}`);
  });

  it("13. TokenRefreshInProgressError (409, another request is refreshing the token) → retry, not 'not retryable'", async () => {
    harness = makeToolHarness({
      proxy: async () => {
        throw new TokenRefreshInProgressError(
          "Token refresh already in progress for grant 'g-1'. Retry in a moment.",
          "g-1",
          { status_code: 409, error: "token_refresh_in_progress" },
        );
      },
    });
    const res = await harness.execute();
    expect(res.isError).toBe(true);
    expect(harness.text(res)).toBe("Temporary failure calling GitHub; please retry.");
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
  });

  it("14. a 429 with a code the SDK doesn't type → rate-limit wording, not 'not retryable'", async () => {
    // The SDK throws a plain BackendError for a 429 it doesn't recognize.
    harness = makeToolHarness({
      proxy: async () => { throw new BackendError("slow down", { status_code: 429, error: "something_new" }); },
    });
    const res = await harness.execute();
    expect(harness.text(res)).toBe(
      "Alter is rate-limiting requests right now. Tell the user to try GitHub again in about 60s.",
    );
  });

  it("15. a sign-in that won't start is logged, never echoed to the chat", async () => {
    // startLogin's error is an SDK/backend message meant for the operator.
    harness = makeToolHarness({
      proxy: async () => { throw new StepUpRequiredError("stale session"); },
      startLogin: async () => { throw new Error("createAuthSession failed: internal detail"); },
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toBe("This action needs a fresh sign-in and I couldn't start one. Try again shortly.");
    expect(text).not.toContain("internal detail");
    const warn = harness.logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warn).toContain("alter_test_tool could not start a sign-in: Error: createAuthSession failed: internal detail");
  });

  it("16. a failed grant probe logs the backend's key hint for the operator", async () => {
    const hint = "Keys created before the September 2026 key-security upgrade must be replaced.";
    harness = makeToolHarness({
      seedGrantId: null,
      listGrants: async () => {
        throw new InvalidKeyError({
          message: "Invalid API key",
          details: { status_code: 401, error: "invalid_key" },
          hint,
        });
      },
    });
    await harness.execute();
    const warn = harness.logger.warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warn).toContain("listGrants probe failed");
    expect(warn).toContain(`hint=${JSON.stringify(hint)}`);
  });
});

/** What the SDK throws for the backend's 403 `insufficient_scope`. */
function scopeError(missing: string[]): InsufficientScopeError {
  return new InsufficientScopeError(`Missing required scope(s): ${missing.join(", ")}`, {
    required: missing,
    granted: ["providers:read"],
    missing,
    details: { status_code: 403, error: "insufficient_scope" },
  });
}

/**
 * An Alter API key minted without a scope the plugin needs. No user can fix or
 * wait this out, so every place a key is used must say so plainly and log the
 * scope names for the operator, never "try again" or a reconnect link.
 */
describe("Alter API key missing a scope → operator message, scope names logged", () => {
  const TEXT =
    "This assistant's Alter API key is missing a permission it needs, so this can't work " +
    "until the operator fixes the key. Retrying or signing in again won't help.";

  function expectKeyScope(h: ToolHarness, text: string, doing: string, scope: string): void {
    expect(text).toContain(TEXT);
    expect(text).not.toContain("Try again");
    expect(text).not.toContain("Click here");
    expect(h.logger.error).toHaveBeenCalledTimes(1);
    const logged = h.logger.error.mock.calls[0]?.[0] as string;
    expect(logged).toContain(`alter_test_tool could not ${doing}: the Alter API key is missing scope(s) [${scope}]`);
  }

  it("17. starting a sign-in (app key lacks idp_users:write)", async () => {
    harness = makeToolHarness({
      identityLink: null,
      startLogin: async () => { throw scopeError(["idp_users:write"]); },
    });
    const res = await harness.execute();
    expect(res.isError).toBe(true);
    expectKeyScope(harness, harness.text(res), "start a sign-in", "idp_users:write");
    expect(harness.proxy).not.toHaveBeenCalled();
  });

  it("18. the grant lookup (agent key lacks grants:read): no connect link, which would loop", async () => {
    harness = makeToolHarness({
      seedGrantId: null,
      listGrants: async () => { throw scopeError(["grants:read"]); },
    });
    const res = await harness.execute();
    expect(res.isError).toBe(true);
    expectKeyScope(harness, harness.text(res), "look up the user's connection", "grants:read");
    expect(harness.buildConnectUrl).not.toHaveBeenCalled();
    expect(harness.proxy).not.toHaveBeenCalled();
  });

  it("19. creating the connect link (agent key lacks connect:initiate)", async () => {
    harness = makeToolHarness({
      seedGrantId: null,
      buildConnectUrl: async () => { throw scopeError(["connect:initiate", "grants:write"]); },
    });
    const res = await harness.execute();
    expect(res.isError).toBe(true);
    expectKeyScope(harness, harness.text(res), "create a connect link", "connect:initiate, grants:write");
  });

  it("20. the tool call itself (agent key lacks proxy:execute): grant cache kept", async () => {
    harness = makeToolHarness({ proxy: async () => { throw scopeError(["proxy:execute"]); } });
    const res = await harness.execute();
    expect(res.isError).toBe(true);
    expectKeyScope(harness, harness.text(res), "call github", "proxy:execute");
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
    expect(harness.buildConnectUrl).not.toHaveBeenCalled();
  });
});
