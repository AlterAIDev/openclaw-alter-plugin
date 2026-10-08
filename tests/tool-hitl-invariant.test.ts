import { afterEach, describe, expect, it } from "vitest";
import { makeToolHarness, ApprovalResult, type ToolHarness } from "./helpers/tool-harness.js";

/**
 * The `hitl: true` post-call invariant. Server-side Alter policy is the source
 * of truth for approval gating, but the SDK can't pre-check it — so when a
 * spec marked HITL executes synchronously (a plain `ApprovalResult`, meaning
 * the backend ran it WITHOUT an approval), the plugin logs ERROR and drops the
 * grant cache to force a fresh probe. A non-HITL spec takes the same success
 * path with none of that.
 */

let harness: ToolHarness;
afterEach(() => harness?.cleanup());

function jsonResult(body: unknown): ApprovalResult {
  return new ApprovalResult({
    status_code: 200,
    headers: {},
    body_b64: Buffer.from(JSON.stringify(body)).toString("base64"),
  });
}

describe("hitl invariant", () => {
  it("1. hitl:true + synchronous ApprovalResult → ERROR log + cache drop, still okResult", async () => {
    harness = makeToolHarness({
      hitl: true,
      proxy: async () => jsonResult({ ok: true, count: 2 }),
    });
    const res = await harness.execute();
    // The result is still surfaced (the action DID run) — the violation is an
    // operator signal, not a user-facing failure.
    expect(res.isError).toBe(false);
    const text = harness.text(res);
    expect(text).toContain('"ok":true');
    expect(text).toContain('"partial"');
    // Operator-visible ERROR naming the offending grant.
    expect(harness.logger.error).toHaveBeenCalledTimes(1);
    const err = harness.logger.error.mock.calls[0]?.[0] as string;
    expect(err).toContain("HITL VIOLATION");
    expect(err).toContain("grant-test-1");
    // Cache dropped so the next call re-probes (operator pairs this with a policy fix).
    expect(harness.grants.get(harness.appUserId, "github")).toBeUndefined();
  });

  it("2. hitl:false happy path → okResult, no ERROR, cache preserved", async () => {
    harness = makeToolHarness({
      hitl: false,
      proxy: async () => jsonResult({ ok: true }),
    });
    const res = await harness.execute();
    expect(res.isError).toBe(false);
    expect(harness.text(res)).toContain('"ok":true');
    expect(harness.logger.error).not.toHaveBeenCalled();
    // Read-only tool, clean call — the cached grant is untouched.
    expect(harness.grants.get(harness.appUserId, "github")).toBe("grant-test-1");
    expect(harness.proxy).toHaveBeenCalledTimes(1);
  });
});
