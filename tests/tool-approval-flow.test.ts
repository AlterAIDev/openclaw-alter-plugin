import { afterEach, describe, expect, it } from "vitest";
import {
  makeToolHarness,
  approvalStatus,
  InvalidKeyError,
  pendingApproval as pending,
  type ToolHarness,
} from "./helpers/tool-harness.js";

/**
 * HITL approval lifecycle. The local pending-approval lock gates a session so a
 * second write can't queue while the user decides. Alter executes an APPROVED
 * request server-side and never re-invokes the plugin, so the lock has no
 * in-band "it finished" callback — the top-of-execute short-circuit RECONCILES
 * the lock against the backend via `agent.getApprovalStatus(...)`:
 *   - non-terminal (pending/approved/executing) → keep gating (replay the URL);
 *   - terminal (executed/denied/expired/failed) → clear the lock + report the
 *     outcome, and DO NOT re-run the tool (an executed approval already ran
 *     server-side; re-executing would double-send);
 *   - poll error → fail safe: keep the lock + replay (the 1-hour TTL backstops).
 * Blindly replaying a stale (already-executed) URL was the reported bug.
 */

let harness: ToolHarness;
afterEach(() => harness?.cleanup());

describe("approval flow", () => {
  it("1. a still-pending lock short-circuits after polling (proxy never called)", async () => {
    harness = makeToolHarness({
      pendingLock: {
        approvalId: "appr_pre",
        approvalUrl: "https://wallet/approvals/appr_pre",
        toolName: "alter_gmail_send",
      },
      getApprovalStatus: async () => approvalStatus("pending", { approvalId: "appr_pre" }),
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain(
      "You have a pending approval for alter_gmail_send: https://wallet/approvals/appr_pre",
    );
    // We reconciled against the backend before replaying, and it's still open.
    expect(harness.getApprovalStatus).toHaveBeenCalledWith("appr_pre");
    // ...and the poll SUCCEEDED. The poll-failure branch (test 8) replays the
    // same URL, so without these two a fixture the SDK refuses to construct
    // would pass here while exercising the wrong branch.
    expect(harness.logger.warn).not.toHaveBeenCalled();
    expect(text).not.toContain("Type /alter status to clear");
    // The lock guard returns before any provider call, and the lock is preserved.
    expect(harness.proxy).not.toHaveBeenCalled();
    expect(harness.approvalLock.activeFor(harness.sessionId, harness.appUserId)?.approvalId).toBe("appr_pre");
  });

  it("2. PendingApproval sets the lock and returns 'Awaiting your approval'", async () => {
    harness = makeToolHarness({
      proxy: async () => pending("appr-new", "https://wallet/approvals/appr-new"),
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("Awaiting your approval at https://wallet/approvals/appr-new.");
    expect(text).toContain("Reply 'approved'");
    // Lock is now held for this session, keyed to the new approval + tool.
    const active = harness.approvalLock.activeFor(harness.sessionId, harness.appUserId);
    expect(active?.approvalId).toBe("appr-new");
    expect(active?.toolName).toBe("alter_test_tool");
    // No conflicting lock → no warn.
    expect(harness.logger.warn).not.toHaveBeenCalled();
    expect(harness.proxy).toHaveBeenCalledTimes(1);
  });

  it("3. conflicting-lock race → logger.warn, both URLs surfaced, existing lock preserved", async () => {
    harness = makeToolHarness({});
    // Simulate a different approval landing on the session between the top-of-
    // execute lock check (empty) and our post-proxy `set` — the classic race.
    harness.proxy.mockImplementation(async () => {
      harness.approvalLock.set(harness.sessionId, harness.appUserId, {
        approvalId: "appr_other",
        approvalUrl: "https://wallet/approvals/appr_other",
        toolName: "other_tool",
        createdAt: Date.now(),
      });
      return pending("appr_ours", "https://wallet/approvals/appr_ours");
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("Awaiting your approval at https://wallet/approvals/appr_ours.");
    expect(harness.logger.warn).toHaveBeenCalledTimes(1);
    const warn = harness.logger.warn.mock.calls[0]?.[0] as string;
    expect(warn).toContain("appr_ours");
    expect(warn).toContain("another pending approval is already locked");
    // `set` was rejected — the pre-existing (other) lock is NOT overwritten.
    expect(harness.approvalLock.activeFor(harness.sessionId, harness.appUserId)?.approvalId).toBe("appr_other");
  });

  it("4. an executed lock is cleared and reported — no replay, no double-send (regression)", async () => {
    harness = makeToolHarness({
      pendingLock: {
        approvalId: "appr_done",
        approvalUrl: "https://wallet/approvals/appr_done",
        toolName: "alter_gmail_send",
      },
      getApprovalStatus: async () =>
        approvalStatus("executed", { approvalId: "appr_done", hasResult: true }),
      // Present but must NOT be called — re-executing would double-send.
      proxy: async () => pending("appr_new", "https://wallet/approvals/appr_new"),
    });
    const res = await harness.execute();
    const text = harness.text(res);
    // Reported as a successful (non-error) outcome, NOT the stale approval URL.
    expect(res.isError).toBe(false);
    expect(text).toContain("Your earlier alter_gmail_send was approved and already completed");
    expect(text).not.toContain("https://wallet/approvals/appr_done");
    // The whole point: the write is never re-run.
    expect(harness.proxy).not.toHaveBeenCalled();
    // Lock cleared so subsequent calls proceed.
    expect(harness.approvalLock.activeFor(harness.sessionId, harness.appUserId)).toBeUndefined();
  });

  it("5. a denied lock is cleared and reported", async () => {
    harness = makeToolHarness({
      pendingLock: {
        approvalId: "appr_d",
        approvalUrl: "https://wallet/approvals/appr_d",
        toolName: "alter_gmail_send",
      },
      getApprovalStatus: async () => approvalStatus("denied", { approvalId: "appr_d" }),
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain(
      "Your earlier alter_gmail_send approval was denied. Ask again if you'd like.",
    );
    expect(harness.proxy).not.toHaveBeenCalled();
    expect(harness.approvalLock.activeFor(harness.sessionId, harness.appUserId)).toBeUndefined();
  });

  it("6. an expired lock is cleared and reported", async () => {
    harness = makeToolHarness({
      pendingLock: {
        approvalId: "appr_e",
        approvalUrl: "https://wallet/approvals/appr_e",
        toolName: "alter_slack_post_message",
      },
      getApprovalStatus: async () => approvalStatus("expired", { approvalId: "appr_e" }),
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain(
      "Your earlier alter_slack_post_message approval expired before you decided. Ask again if you'd like.",
    );
    expect(harness.approvalLock.activeFor(harness.sessionId, harness.appUserId)).toBeUndefined();
  });

  it("7. a failed lock is cleared and surfaces the execution error", async () => {
    harness = makeToolHarness({
      pendingLock: {
        approvalId: "appr_f",
        approvalUrl: "https://wallet/approvals/appr_f",
        toolName: "alter_gmail_send",
      },
      getApprovalStatus: async () =>
        approvalStatus("failed", {
          approvalId: "appr_f",
          executionError: "provider 500 after approve",
        }),
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain(
      "Your earlier alter_gmail_send approval failed during execution: provider 500 after approve. Ask again if you'd like.",
    );
    expect(harness.approvalLock.activeFor(harness.sessionId, harness.appUserId)).toBeUndefined();
  });

  it("8. a poll failure keeps the lock and replays the URL (fail-safe)", async () => {
    harness = makeToolHarness({
      pendingLock: {
        approvalId: "appr_pre",
        approvalUrl: "https://wallet/approvals/appr_pre",
        toolName: "alter_gmail_send",
      },
      getApprovalStatus: async () => {
        throw new Error("network down");
      },
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain(
      "You have a pending approval for alter_gmail_send: https://wallet/approvals/appr_pre",
    );
    expect(text).toContain("Type /alter status to clear");
    expect(harness.logger.warn).toHaveBeenCalledTimes(1);
    expect(harness.proxy).not.toHaveBeenCalled();
    // Never clear a lock we can't confirm resolved.
    expect(harness.approvalLock.activeFor(harness.sessionId, harness.appUserId)?.approvalId).toBe("appr_pre");
  });

  it("9. after a stale lock is cleared, the next call reaches the proxy", async () => {
    harness = makeToolHarness({
      pendingLock: {
        approvalId: "appr_done",
        approvalUrl: "https://wallet/approvals/appr_done",
        toolName: "alter_gmail_send",
      },
      getApprovalStatus: async () =>
        approvalStatus("executed", { approvalId: "appr_done", hasResult: true }),
      proxy: async () => pending("appr_fresh", "https://wallet/approvals/appr_fresh"),
    });
    // 1st call: stale executed lock → cleared + reported; proxy NOT called.
    const first = await harness.execute();
    expect(harness.text(first)).toContain("already completed");
    expect(harness.proxy).not.toHaveBeenCalled();
    expect(harness.approvalLock.activeFor(harness.sessionId, harness.appUserId)).toBeUndefined();
    // 2nd call: no lock → proceeds to the proxy, which creates a FRESH approval.
    const second = await harness.execute();
    const text = harness.text(second);
    expect(harness.proxy).toHaveBeenCalledTimes(1);
    expect(text).toContain("Awaiting your approval at https://wallet/approvals/appr_fresh.");
    expect(harness.approvalLock.activeFor(harness.sessionId, harness.appUserId)?.approvalId).toBe("appr_fresh");
  });

  it("10. a multi-gate (N-of-N) approval surfaces EVERY gate's link and locks the executor gate", async () => {
    // Each gate is a distinct approver set and all must approve. Relaying only
    // the top-level (executor) URL would strand the other approvers.
    harness = makeToolHarness({
      proxy: async () =>
        pending("appr_exec", "https://wallet/approvals/appr_exec", {
          extraGateUrls: ["https://wallet/approvals/appr_mgr"],
        }),
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("This needs 2 separate approvals");
    expect(text).toContain("1. https://wallet/approvals/appr_exec");
    expect(text).toContain("2. https://wallet/approvals/appr_mgr");
    expect(text).toContain("Reply 'approved' once every approval is done.");
    // The lock polls the executor gate, whose status is the group's derived one.
    const active = harness.approvalLock.activeFor(harness.sessionId, harness.appUserId);
    expect(active?.approvalId).toBe("appr_exec");
    expect(active?.approvalUrl).toBe("https://wallet/approvals/appr_exec");
    // The audit line records the group so a stuck multi-party approval is triageable.
    const logged = harness.logger.info.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("group=grp_appr_exec gates=2");
    expect(logged).not.toContain("wallet/approvals/");
    // Every gate is stored, so a later replay can still reach the other approver.
    expect(active?.gates).toEqual([
      { approvalId: "appr_exec", approvalUrl: "https://wallet/approvals/appr_exec" },
      { approvalId: "appr_exec_g2", approvalUrl: "https://wallet/approvals/appr_mgr" },
    ]);
  });

  /** A lock for a 2-gate group: the requester's (executor) gate and a manager's. */
  const TWO_GATE_LOCK = {
    approvalId: "appr_exec",
    approvalUrl: "https://wallet/approvals/appr_exec",
    toolName: "alter_gmail_send",
    gates: [
      { approvalId: "appr_exec", approvalUrl: "https://wallet/approvals/appr_exec" },
      { approvalId: "appr_mgr", approvalUrl: "https://wallet/approvals/appr_mgr" },
    ],
  };

  it("11. multi-gate replay lists only the gates still undecided", async () => {
    // The requester approved their own gate; the manager hasn't. Re-serving the
    // requester's link would send them back to what they already did, and drop
    // the manager's link from every later message.
    harness = makeToolHarness({
      pendingLock: TWO_GATE_LOCK,
      getApprovalStatus: async () =>
        approvalStatus("pending", {
          approvalId: "appr_exec",
          gates: [
            { approvalId: "appr_exec", status: "approved" },
            { approvalId: "appr_mgr", status: "pending" },
          ],
        }),
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toContain("1 of 2 approvals still need a decision");
    expect(text).toContain("1. https://wallet/approvals/appr_mgr");
    expect(text).not.toContain("appr_exec");
    expect(harness.proxy).not.toHaveBeenCalled();
    expect(harness.approvalLock.activeFor(harness.sessionId, harness.appUserId)?.approvalId).toBe("appr_exec");
  });

  it("12. multi-gate poll failure lists every gate (can't tell which are done)", async () => {
    harness = makeToolHarness({
      pendingLock: TWO_GATE_LOCK,
      getApprovalStatus: async () => {
        throw new Error("network down");
      },
    });
    const text = harness.text(await harness.execute());
    expect(text).toContain("2 of 2 approvals still need a decision");
    expect(text).toContain("1. https://wallet/approvals/appr_exec");
    expect(text).toContain("2. https://wallet/approvals/appr_mgr");
    expect(text).toContain("Type /alter status to clear");
  });

  it("13. an approved-and-running group says so instead of sending the user back to the wallet", async () => {
    harness = makeToolHarness({
      pendingLock: TWO_GATE_LOCK,
      getApprovalStatus: async () =>
        approvalStatus("executing", {
          approvalId: "appr_exec",
          gates: [
            { approvalId: "appr_exec", status: "approved" },
            { approvalId: "appr_mgr", status: "approved" },
          ],
        }),
    });
    const res = await harness.execute();
    const text = harness.text(res);
    expect(res.isError).toBe(true);
    expect(text).toBe(
      "Your earlier alter_gmail_send was approved and is running now. Ask again in a moment for the outcome.",
    );
    expect(text).not.toContain("wallet/approvals/");
    // Still running, so the lock stays: a second write must not queue behind it.
    expect(harness.proxy).not.toHaveBeenCalled();
    expect(harness.approvalLock.activeFor(harness.sessionId, harness.appUserId)?.approvalId).toBe("appr_exec");
  });

  it("14. a poll failure logs the backend's key hint for the operator", async () => {
    const hint = "Keys created before the September 2026 key-security upgrade must be replaced.";
    harness = makeToolHarness({
      pendingLock: { approvalId: "appr_pre" },
      getApprovalStatus: async () => {
        throw new InvalidKeyError({
          message: "Invalid API key",
          details: { status_code: 401, error: "invalid_key" },
          hint,
        });
      },
    });
    const text = harness.text(await harness.execute());
    expect(text).not.toContain("September 2026");
    const warn = harness.logger.warn.mock.calls[0]?.[0] as string;
    expect(warn).toContain("approval-status poll failed");
    expect(warn).toContain(`hint=${JSON.stringify(hint)}`);
  });
});
