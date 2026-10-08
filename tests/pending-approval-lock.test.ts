import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PendingApprovalLock, outstandingGates } from "../src/pending-approval-lock.js";
import { closeDatabase, openDatabase } from "../src/sqlite.js";
import { approvalStatus } from "./helpers/tool-harness.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "alter-lock-"));
});
afterEach(() => {
  closeDatabase();
  rmSync(tmp, { recursive: true, force: true });
});

function rec(toolName = "alter_gmail_send"): {
  approvalId: string;
  approvalUrl: string;
  toolName: string;
  createdAt: number;
} {
  return {
    approvalId: "appr_1",
    approvalUrl: "https://wallet/approvals/appr_1",
    toolName,
    createdAt: Date.now(),
  };
}

const USER = "idp:user1";

describe("PendingApprovalLock TTL auto-purge", () => {
  it("returns the record when fresh", () => {
    const lock = new PendingApprovalLock(tmp);
    lock.set("sess", USER, rec());
    expect(lock.activeFor("sess", USER)?.toolName).toBe("alter_gmail_send");
  });

  it("auto-purges and returns undefined when older than maxAgeMs", () => {
    const lock = new PendingApprovalLock(tmp, 10_000); // 10s window
    lock.set("sess", USER, { ...rec(), createdAt: Date.now() - 60_000 });
    // Lock is older than the window — activeFor should both return undefined
    // AND remove the row so a fresh `set` works without manual `clear`.
    expect(lock.activeFor("sess", USER)).toBeUndefined();
    expect(lock.activeFor("sess", USER)).toBeUndefined();
    lock.set("sess", USER, rec());
    expect(lock.activeFor("sess", USER)?.toolName).toBe("alter_gmail_send");
  });

  it("keeps a fresh lock even when the stored expiry has passed (floor lets the poll report the terminal)", () => {
    const lock = new PendingApprovalLock(tmp); // default 1h floor
    // Recently created but the stored window already closed. The maxAge floor
    // keeps the lock alive so the next tool call polls the real terminal (e.g.
    // an approval that executed just before expiry) instead of minting a
    // duplicate. Expiry never purges BELOW the floor.
    lock.set("sess", USER, { ...rec(), createdAt: Date.now(), expiresAtMs: Date.now() - 1_000 });
    expect(lock.activeFor("sess", USER)?.approvalId).toBe("appr_1");
  });

  it("purges only when past BOTH the maxAge floor and the approval expiry", () => {
    const lock = new PendingApprovalLock(tmp, 10_000); // 10s floor
    lock.set("sess", USER, {
      ...rec(),
      createdAt: Date.now() - 60_000, // past the 10s floor
      expiresAtMs: Date.now() - 30_000, // and past the window
    });
    expect(lock.activeFor("sess", USER)).toBeUndefined();
  });

  it("keeps a lock past the maxAge floor while the approval window is still open", () => {
    const lock = new PendingApprovalLock(tmp, 10_000); // 10s floor
    // Past the floor, but the window is still open → the lock survives, so a
    // still-pending long-window approval can't be duplicated on retry.
    lock.set("sess", USER, {
      ...rec(),
      createdAt: Date.now() - 60_000,
      expiresAtMs: Date.now() + 60_000,
    });
    expect(lock.activeFor("sess", USER)?.approvalId).toBe("appr_1");
  });

  it("round-trips the stored approval expiry on read", () => {
    const lock = new PendingApprovalLock(tmp);
    const expiresAtMs = Date.now() + 30 * 60_000;
    lock.set("sess", USER, { ...rec(), expiresAtMs });
    expect(lock.activeFor("sess", USER)?.expiresAtMs).toBe(expiresAtMs);
  });

  it("clear() drops the lock", () => {
    const lock = new PendingApprovalLock(tmp);
    lock.set("sess", USER, rec());
    lock.clear("sess", USER);
    expect(lock.activeFor("sess", USER)).toBeUndefined();
  });

  it("each session has its own lock", () => {
    const lock = new PendingApprovalLock(tmp);
    lock.set("sess-A", USER, rec("alter_gmail_send"));
    lock.set("sess-B", USER, rec("alter_slack_post_message"));
    expect(lock.activeFor("sess-A", USER)?.toolName).toBe("alter_gmail_send");
    expect(lock.activeFor("sess-B", USER)?.toolName).toBe("alter_slack_post_message");
  });

  it("REFUSES to overwrite a different fresh lock on the same session", () => {
    const lock = new PendingApprovalLock(tmp);
    const r1 = rec("alter_gmail_send");
    const rejected1 = lock.set("sess", USER, r1);
    expect(rejected1).toBe(false);

    // Different approvalId for a different tool — must be refused; the
    // existing in-flight approval is preserved.
    const r2 = { ...rec("alter_slack_post_message"), approvalId: "appr_2" };
    const rejected2 = lock.set("sess", USER, r2);
    expect(rejected2).toBe(true);
    // Lock state didn't change.
    const active = lock.activeFor("sess", USER);
    expect(active?.toolName).toBe("alter_gmail_send");
    expect(active?.approvalId).toBe("appr_1");
  });

  it("idempotent set with the SAME approvalId is allowed (refreshes timestamps)", () => {
    const lock = new PendingApprovalLock(tmp);
    const r1 = rec();
    lock.set("sess", USER, r1);
    // Same approvalId, just re-asserting — should be allowed.
    const rejected = lock.set("sess", USER, { ...r1, createdAt: r1.createdAt + 1000 });
    expect(rejected).toBe(false);
    expect(lock.activeFor("sess", USER)?.approvalId).toBe("appr_1");
  });

  it("set OVER a stale lock is allowed (the stale row is auto-purged)", () => {
    const lock = new PendingApprovalLock(tmp, 10_000);
    lock.set("sess", USER, { ...rec(), createdAt: Date.now() - 60_000 });
    // New lock should be accepted because the existing one is stale.
    const rejected = lock.set("sess", USER, { ...rec("alter_slack_post_message"), approvalId: "appr_2" });
    expect(rejected).toBe(false);
    expect(lock.activeFor("sess", USER)?.toolName).toBe("alter_slack_post_message");
  });
});

const GATES = [
  { approvalId: "appr_1", approvalUrl: "https://wallet/approvals/appr_1" },
  { approvalId: "appr_2", approvalUrl: "https://wallet/approvals/appr_2" },
];

describe("PendingApprovalLock multi-gate links", () => {
  it("round-trips every gate of a multi-party approval", () => {
    const lock = new PendingApprovalLock(tmp);
    lock.set("sess", USER, { ...rec(), gates: GATES });
    expect(lock.activeFor("sess", USER)?.gates).toEqual(GATES);
  });

  it("stores nothing extra for a single gate", () => {
    const lock = new PendingApprovalLock(tmp);
    lock.set("sess", USER, { ...rec(), gates: [GATES[0]!] });
    expect(lock.activeFor("sess", USER)?.gates).toBeUndefined();
  });

  it("a malformed gates_json degrades to the single-link lock, never throws", () => {
    const lock = new PendingApprovalLock(tmp);
    lock.set("sess", USER, { ...rec(), gates: GATES });
    openDatabase(tmp).prepare(`UPDATE pending_approval_lock SET gates_json = ?`).run("{not json");
    const active = lock.activeFor("sess", USER);
    expect(active?.approvalId).toBe("appr_1");
    expect(active?.gates).toBeUndefined();
  });

  it("outstandingGates drops decided gates and falls back to all when ids don't match", () => {
    const record = { ...rec(), gates: GATES };
    const oneLeft = approvalStatus("pending", {
      approvalId: "appr_1",
      gates: [
        { approvalId: "appr_1", status: "approved" },
        { approvalId: "appr_2", status: "pending" },
      ],
    });
    expect(outstandingGates(record, oneLeft)).toEqual([GATES[1]]);
    const unknownIds = approvalStatus("pending", {
      approvalId: "appr_1",
      gates: [
        { approvalId: "other_a", status: "approved" },
        { approvalId: "other_b", status: "approved" },
      ],
    });
    expect(outstandingGates(record, unknownIds)).toEqual([GATES[0], GATES[1]]);
    expect(outstandingGates(record)).toEqual(GATES);
    // Single gate: its own link, whatever the poll says.
    expect(outstandingGates(rec(), oneLeft)).toEqual([GATES[0]]);
  });
});

describe("schema v6 → v7 migration", () => {
  it("adds gates_json in place and keeps an existing lock row", () => {
    // A v6 database, built the way v6 left it: no gates_json column.
    const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
      DatabaseSync: new (path: string) => {
        prepare: (sql: string) => { run: (...p: unknown[]) => unknown };
        close: () => void;
      };
    };
    mkdirSync(join(tmp, ".alter"), { recursive: true });
    const raw = new DatabaseSync(join(tmp, ".alter", "plugin.sqlite"));
    raw.prepare(
      `CREATE TABLE pending_approval_lock (
        session_id TEXT NOT NULL, app_user_id TEXT NOT NULL, approval_id TEXT NOT NULL,
        approval_url TEXT NOT NULL, tool_name TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
        expires_at_ms INTEGER, PRIMARY KEY (session_id, app_user_id))`,
    ).run();
    raw.prepare(
      `INSERT INTO pending_approval_lock VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("sess", USER, "appr_old", "https://wallet/approvals/appr_old", "alter_gmail_send", Date.now(), null);
    raw.prepare(`PRAGMA user_version = 6`).run();
    raw.close();

    const lock = new PendingApprovalLock(tmp);
    // The in-flight lock survives the upgrade...
    expect(lock.activeFor("sess", USER)?.approvalId).toBe("appr_old");
    // ...and the new column is writable.
    lock.set("sess2", USER, { ...rec(), gates: GATES });
    expect(lock.activeFor("sess2", USER)?.gates).toEqual(GATES);
    const version = openDatabase(tmp).prepare(`PRAGMA user_version`).get() as { user_version: number };
    expect(version.user_version).toBe(7);
  });
});
