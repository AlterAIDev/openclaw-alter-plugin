import { afterEach, describe, expect, it } from "vitest";
import { makeToolHarness, ApprovalResult, type ToolHarness } from "./helpers/tool-harness.js";

/**
 * proxyRequest argument-forwarding contract. The INTERNAL `toProxyArgs`
 * contract (`jsonBody`/`headers`/`queryParams`, stable across every tool spec
 * and the `AlterToolSpec` type) is remapped at the single proxyRequest call
 * site to the SDK's wire names (`json`/`extraHeaders`/`queryParams`). Two
 * regression traps this file pins:
 *   - C1: object-spreading the internal contract compiles (excess-property
 *     check is defeated by the spread) but the SDK never reads `jsonBody`/
 *     `headers`, dropping the request body + Content-Type at runtime — every
 *     write tool then sends an empty body → provider 400. Assert the SDK
 *     RECEIVES `json`/`extraHeaders`, never the internal names.
 *   - T1: the per-call `userToken` (which delegation this call runs under) must
 *     be forwarded; dropping it keeps every other test green.
 */

let harness: ToolHarness;
afterEach(() => harness?.cleanup());

function ok200(body: unknown): ApprovalResult {
  return new ApprovalResult({
    status_code: 200,
    headers: {},
    body_b64: Buffer.from(JSON.stringify(body)).toString("base64"),
  });
}

describe("proxyRequest argument forwarding", () => {
  it("C1. remaps internal jsonBody/headers → SDK json/extraHeaders (never the wrong keys)", async () => {
    const jsonBody = { raw: "encoded-message", nested: { a: 1 } };
    const headers = { "Content-Type": "application/json", "X-Extra": "v" };
    harness = makeToolHarness({
      toProxyArgs: async () => ({
        method: "POST",
        url: "https://api.example.com/send",
        jsonBody,
        headers,
        queryParams: { dryRun: true },
      }),
      proxy: async () => ok200({ ok: true }),
    });
    const res = await harness.execute();
    expect(res.isError).toBe(false);
    expect(harness.proxy).toHaveBeenCalledTimes(1);
    const arg = harness.proxy.mock.calls[0]?.[0] as Record<string, unknown>;
    // The SDK reads json/extraHeaders — the remap MUST hand it those keys.
    expect(arg["json"]).toEqual(jsonBody);
    expect(arg["extraHeaders"]).toEqual(headers);
    expect(arg["queryParams"]).toEqual({ dryRun: true });
    // The internal contract names MUST NOT leak through — if they did, the SDK
    // would ignore them and the body/headers would be silently dropped.
    expect(arg).not.toHaveProperty("jsonBody");
    expect(arg).not.toHaveProperty("headers");
  });

  it("C1b. omits json/extraHeaders entirely when the spec supplies neither", async () => {
    // The default read-tool toProxyArgs returns only queryParams — so a call
    // with no body must not smuggle an empty `json`/`extraHeaders` onto the SDK.
    harness = makeToolHarness({ proxy: async () => ok200({ ok: true }) });
    const res = await harness.execute();
    expect(res.isError).toBe(false);
    const arg = harness.proxy.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("json");
    expect(arg).not.toHaveProperty("extraHeaders");
    expect(arg["queryParams"]).toEqual({ q: "x" });
  });

  it("T1. forwards the per-call userToken (which delegation this call runs under)", async () => {
    harness = makeToolHarness({
      identityLink: { jwt: "seeded.jwt.value" },
      proxy: async () => ok200({ ok: true }),
    });
    await harness.execute();
    const arg = harness.proxy.mock.calls[0]?.[0] as { userToken?: string; grantId?: string };
    expect(arg.userToken).toBe("seeded.jwt.value");
    expect(arg.grantId).toBe("grant-test-1");
  });
});
