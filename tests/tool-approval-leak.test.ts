import { afterEach, describe, expect, it } from "vitest";
import {
  makeToolHarness,
  approvalStatus,
  pendingApproval,
  type ToolHarness,
} from "./helpers/tool-harness.js";

/**
 * End-to-end cross-user approval isolation, at the TOOL layer.
 *
 * tests/approval-lock-cross-user.test.ts pins the store. This pins the thing
 * that would reach a user's screen: if `registerAlterTool`'s execute()
 * consulted the lock BEFORE resolving identity, it would serve the pending
 * record — wallet URL and tool name — to whoever called. In a Slack group DM
 * that means any participant, including one who has never signed in.
 *
 * The gate order (identity -> lock) prevents that, and it is what these tests
 * defend. If someone reorders those blocks for "efficiency", this suite fails.
 */

let harness: ToolHarness | undefined;
afterEach(() => {
  harness?.cleanup();
  harness = undefined;
});

describe("a tool call must not surface another user's pending approval", () => {
  it("does not replay a lock belonging to a DIFFERENT app_user in the same session", async () => {
    // The harness seeds the lock for ITS user; we then run the tool as a
    // different identity on the same session — the group-DM shape.
    harness = makeToolHarness({
      pendingLock: { toolName: "alter_gmail_send", approvalId: "appr_alice" },
      identityLink: { appUserId: "idp:auth0|alice", idpSub: "alice" },
      proxy: async () => {
        throw new Error("proxy should not run in this test");
      },
    });
    // Sanity: Alice IS gated (the lock works for its owner).
    const alice = await harness.execute();
    expect(harness.text(alice)).toContain("pending approval");
    harness.cleanup();

    // Now Bob: same session id, different identity, no lock of his own.
    harness = makeToolHarness({
      identityLink: { appUserId: "idp:auth0|bob", idpSub: "bob" },
      proxy: async () => {
        throw new Error("BOOM: reached the provider");
      },
    });
    // Bob's own tool call proceeds to HIS pipeline (and fails on the stub proxy)
    // rather than being handed Alice's approval. The assertion that matters is
    // the absence of her data.
    let text = "";
    try {
      text = harness.text(await harness.execute());
    } catch (e) {
      text = e instanceof Error ? e.message : String(e);
    }
    expect(text).not.toContain("appr_alice");
    expect(text).not.toContain("wallet/approvals/appr_alice");
  });

  it("prompts an UNSIGNED-IN user to sign in — never shows them a pending approval", async () => {
    // The sharpest form of the old bug: the lock check ran before the identity
    // gate, so someone with no Alter identity at all still got the wallet URL.
    harness = makeToolHarness({
      pendingLock: { toolName: "alter_gmail_send", approvalId: "appr_alice" },
      identityLink: null, // caller has never signed in
      getApprovalStatus: async () => {
        throw new Error("must not poll: identity comes first");
      },
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(text).toContain("sign in");
    expect(text).not.toContain("appr_alice");
    expect(text).not.toContain("pending approval");
    // And we must not have burned a backend poll on a stranger's approval id.
    expect(harness.getApprovalStatus).not.toHaveBeenCalled();
  });

  it("still gates the lock's OWNER (the fix must not disable the lock)", async () => {
    harness = makeToolHarness({
      pendingLock: { toolName: "alter_gmail_send", approvalId: "appr_mine" },
      getApprovalStatus: async () => approvalStatus("pending", { approvalId: "appr_mine" }),
      proxy: async () => {
        throw new Error("BOOM: queued a second write while one was pending");
      },
    });
    const res = await harness.execute();
    expect(harness.text(res)).toContain("pending approval for alter_gmail_send");
    expect(harness.proxy).not.toHaveBeenCalled();
  });

  it("logs HITL creation so the gateway has an audit trail", async () => {
    // The success path logs nothing, so without this line a staged email send
    // would leave no trace in the gateway logs at all.
    harness = makeToolHarness({
      hitl: true,
      proxy: async () => pendingApproval("appr_new", "https://wallet/approvals/appr_new"),
    });
    await harness.execute();
    const logged = harness.logger.info.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("HITL approval created appr_new");
    // Correlatable by hashed user, never the raw app_user_id...
    expect(logged).toContain("app_user_h=");
    expect(logged).not.toContain("idp:user1");
    // ...and never the wallet URL: it's the actionable secret and logs ship.
    expect(logged).not.toContain("wallet/approvals/appr_new");
  });
});
