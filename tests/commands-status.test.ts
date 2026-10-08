import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { Agent, ApprovalStatus } from "@alter-ai/alter-sdk";
import type {
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { registerCommands, type CommandsDeps } from "../src/commands.js";
import { IdentityStore } from "../src/identity/store.js";
import { PendingApprovalLock } from "../src/pending-approval-lock.js";
import { closeDatabase } from "../src/sqlite.js";
import { approvalStatus } from "./helpers/tool-harness.js";

/**
 * `/alter status` reconciles the local pending-approval lock against the
 * backend before reporting it, so it never shows an already-resolved approval
 * (approved+executed server-side, denied, expired, failed) as "pending" — the
 * stale-lock replay bug on the status surface. `status clear` stays a manual
 * force-clear that does NOT depend on a backend poll.
 */

const CHANNEL = "slack";
const CHANNEL_USER = "U777";
const APP_USER = "idp:statususer";
const SESSION = "sess-status";

function setup(opts: {
  lock?: {
    approvalId: string;
    approvalUrl: string;
    toolName: string;
    gates?: Array<{ approvalId: string; approvalUrl: string }>;
  };
  getApprovalStatus?: (approvalId: string) => Promise<ApprovalStatus> | ApprovalStatus;
}): {
  approvalLock: PendingApprovalLock;
  getApprovalStatus: ReturnType<typeof vi.fn>;
  run: (args: string) => Promise<PluginCommandResult>;
  sessionId: string;
  appUserId: string;
  cleanup: () => void;
} {
  const tmp = mkdtempSync(join(tmpdir(), "alter-status-"));
  const identities = new IdentityStore(tmp, randomBytes(32));
  const approvalLock = new PendingApprovalLock(tmp);

  identities.upsert({
    channelKind: CHANNEL,
    channelUserId: CHANNEL_USER,
    appUserId: APP_USER,
    idpSub: "statususer",
    jwt: "status.jwt.token",
    jwtExpiresAt: Date.now() + 60 * 60 * 1000,
  });

  if (opts.lock) {
    approvalLock.set(SESSION, APP_USER, { ...opts.lock, createdAt: Date.now() });
  }

  const getApprovalStatus = vi.fn(
    opts.getApprovalStatus ??
      (async () => {
        throw new Error("getApprovalStatus not configured");
      }),
  );
  const agent = { getApprovalStatus } as unknown as Agent;

  const deps = { agent, identities, approvalLock } as unknown as CommandsDeps;

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
      sessionId: SESSION,
      args,
    } as unknown as PluginCommandContext);

  return {
    approvalLock,
    getApprovalStatus,
    run,
    sessionId: SESSION,
    appUserId: APP_USER,
    cleanup: () => {
      closeDatabase();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

let active: { cleanup: () => void } | undefined;
afterEach(() => active?.cleanup());

describe("/alter status", () => {
  it("clears a resolved (executed) lock and reports none", async () => {
    const env = setup({
      lock: {
        approvalId: "appr_done",
        approvalUrl: "https://wallet/approvals/appr_done",
        toolName: "alter_gmail_send",
      },
      getApprovalStatus: async () => approvalStatus("executed", { approvalId: "appr_done" }),
    });
    active = env;
    const res = await env.run("status");
    expect(env.getApprovalStatus).toHaveBeenCalledWith("appr_done");
    expect(res.text).toContain("Pending approval: none");
    expect(res.text).not.toContain("https://wallet/approvals/appr_done");
    expect(env.approvalLock.activeFor(env.sessionId, env.appUserId)).toBeUndefined();
  });

  it("keeps and reports a still-pending lock", async () => {
    const env = setup({
      lock: {
        approvalId: "appr_open",
        approvalUrl: "https://wallet/approvals/appr_open",
        toolName: "alter_gmail_send",
      },
      getApprovalStatus: async () => approvalStatus("pending", { approvalId: "appr_open" }),
    });
    active = env;
    const res = await env.run("status");
    expect(res.text).toContain(
      "Pending approval: alter_gmail_send → https://wallet/approvals/appr_open",
    );
    expect(res.text).toContain("status clear");
    expect(env.approvalLock.activeFor(env.sessionId, env.appUserId)?.approvalId).toBe("appr_open");
  });

  it("keeps the lock on a poll failure (fail-safe)", async () => {
    const env = setup({
      lock: {
        approvalId: "appr_net",
        approvalUrl: "https://wallet/approvals/appr_net",
        toolName: "alter_gmail_send",
      },
      getApprovalStatus: async () => {
        throw new Error("network down");
      },
    });
    active = env;
    const res = await env.run("status");
    expect(res.text).toContain(
      "Pending approval: alter_gmail_send → https://wallet/approvals/appr_net",
    );
    expect(env.approvalLock.activeFor(env.sessionId, env.appUserId)?.approvalId).toBe("appr_net");
  });

  const TWO_GATE_LOCK = {
    approvalId: "appr_exec",
    approvalUrl: "https://wallet/approvals/appr_exec",
    toolName: "alter_gmail_send",
    gates: [
      { approvalId: "appr_exec", approvalUrl: "https://wallet/approvals/appr_exec" },
      { approvalId: "appr_mgr", approvalUrl: "https://wallet/approvals/appr_mgr" },
    ],
  };

  it("lists only the undecided gates of a multi-party approval", async () => {
    const env = setup({
      lock: TWO_GATE_LOCK,
      getApprovalStatus: async () =>
        approvalStatus("pending", {
          approvalId: "appr_exec",
          gates: [
            { approvalId: "appr_exec", status: "approved" },
            { approvalId: "appr_mgr", status: "pending" },
          ],
        }),
    });
    active = env;
    const res = await env.run("status");
    expect(res.text).toContain(
      "Pending approval: alter_gmail_send (1 of 2 approvals still need a decision):\n" +
        "1. https://wallet/approvals/appr_mgr",
    );
    expect(res.text).not.toContain("appr_exec");
  });

  it("lists every gate of a multi-party approval when the poll fails", async () => {
    const env = setup({
      lock: TWO_GATE_LOCK,
      getApprovalStatus: async () => {
        throw new Error("network down");
      },
    });
    active = env;
    const res = await env.run("status");
    expect(res.text).toContain("(2 of 2 approvals still need a decision)");
    expect(res.text).toContain("1. https://wallet/approvals/appr_exec");
    expect(res.text).toContain("2. https://wallet/approvals/appr_mgr");
  });

  it("`status clear` force-clears without polling the backend", async () => {
    const env = setup({
      lock: {
        approvalId: "appr_force",
        approvalUrl: "https://wallet/approvals/appr_force",
        toolName: "alter_gmail_send",
      },
      getApprovalStatus: async () => approvalStatus("pending", { approvalId: "appr_force" }),
    });
    active = env;
    const res = await env.run("status clear");
    expect(res.text).toContain("Pending-approval lock cleared.");
    // The manual escape hatch must not depend on a backend poll.
    expect(env.getApprovalStatus).not.toHaveBeenCalled();
    expect(env.approvalLock.activeFor(env.sessionId, env.appUserId)).toBeUndefined();
  });
});
