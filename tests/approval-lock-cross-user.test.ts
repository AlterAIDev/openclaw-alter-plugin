import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PendingApprovalLock } from "../src/pending-approval-lock.js";
import { closeDatabase } from "../src/sqlite.js";

/**
 * Cross-user isolation of the approval lock.
 *
 * The failure this guards against: a user asks the bot to send an email, and it
 * goes to the wallet for approval. If `PendingApprovalLock` were keyed on
 * `sessionId` ALONE, a DIFFERENT participant of the same Slack group DM would
 * receive the pending approval's wallet URL and tool name from the bot — a
 * group DM is one session shared by everyone in it.
 *
 * The lock is keyed on `(sessionId, appUserId)`. These tests pin that: a
 * session is NOT a user, and one participant's lock must be invisible and
 * untouchable to another.
 *
 * (A shared session also shares the LLM transcript, and with it anything the
 * bot said. That is NOT fixable here — see docs/MULTI_USER_LIMITS.md.)
 */

let tmp: string;
let lock: PendingApprovalLock;

const SESSION = "slack:group-dm:C123"; // one session, several humans
const ALICE = "idp:auth0|alice";
const BOB = "idp:auth0|bob";

function rec(toolName: string, approvalId: string) {
  return {
    approvalId,
    approvalUrl: `https://wallet.example.test/approvals/${approvalId}`,
    toolName,
    createdAt: Date.now(),
    expiresAtMs: Date.now() + 10 * 60_000,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "alter-lock-xuser-"));
  lock = new PendingApprovalLock(tmp);
});

afterEach(() => {
  closeDatabase();
  rmSync(tmp, { recursive: true, force: true });
});

describe("one user's approval must not reach another in a shared session", () => {
  it("does not surface Alice's approval to Bob in the SAME session", () => {
    // Same session id — a group DM — two different humans.
    lock.set(SESSION, ALICE, rec("alter_gmail_send", "appr_alice_email"));

    expect(lock.activeFor(SESSION, ALICE)?.approvalId).toBe("appr_alice_email");
    // Bob must see NOTHING — not Alice's wallet URL, not the fact that she is
    // sending an email.
    expect(lock.activeFor(SESSION, BOB)).toBeUndefined();
  });

  it("never lets Bob's lookup reveal Alice's approvalUrl or toolName", () => {
    // Belt and braces on the two fields that actually leaked.
    lock.set(SESSION, ALICE, rec("alter_gmail_send", "appr_secret"));
    const bobsView = lock.activeFor(SESSION, BOB);
    expect(bobsView).toBeUndefined();
    expect(JSON.stringify(bobsView ?? {})).not.toContain("appr_secret");
    expect(JSON.stringify(bobsView ?? {})).not.toContain("alter_gmail_send");
  });

  it("does not let Bob CLEAR Alice's lock (`/alter status clear`)", () => {
    // The tampering half: clearing by session let any participant drop another's
    // gate, which is what the lock exists to hold — a cleared lock lets a
    // duplicate approval be minted.
    lock.set(SESSION, ALICE, rec("alter_gmail_send", "appr_alice"));
    lock.clear(SESSION, BOB);
    expect(lock.activeFor(SESSION, ALICE)?.approvalId).toBe("appr_alice");
  });

  it("does not let Bob's approval overwrite Alice's in the same session", () => {
    lock.set(SESSION, ALICE, rec("alter_gmail_send", "appr_alice"));
    const raced = lock.set(SESSION, BOB, rec("alter_slack_post_message", "appr_bob"));
    // Bob's write must NOT be treated as a conflict with Alice's — they're
    // independent gates — and must not clobber hers.
    expect(raced).toBe(false);
    expect(lock.activeFor(SESSION, ALICE)?.approvalId).toBe("appr_alice");
    expect(lock.activeFor(SESSION, BOB)?.approvalId).toBe("appr_bob");
  });

  it("still gates the SAME user against queueing a second write", () => {
    // The fix must not weaken the lock's actual purpose.
    lock.set(SESSION, ALICE, rec("alter_gmail_send", "appr_1"));
    const raced = lock.set(SESSION, ALICE, rec("alter_gmail_send", "appr_2"));
    expect(raced).toBe(true);
    expect(lock.activeFor(SESSION, ALICE)?.approvalId).toBe("appr_1");
  });

  it("clears only the caller's own lock, leaving the other's intact", () => {
    lock.set(SESSION, ALICE, rec("alter_gmail_send", "appr_alice"));
    lock.set(SESSION, BOB, rec("alter_slack_post_message", "appr_bob"));
    lock.clear(SESSION, ALICE);
    expect(lock.activeFor(SESSION, ALICE)).toBeUndefined();
    expect(lock.activeFor(SESSION, BOB)?.approvalId).toBe("appr_bob");
  });

  it("keeps the same user's locks separate across different sessions", () => {
    // Alice in the group DM and Alice in her 1:1 DM are separate gates.
    lock.set(SESSION, ALICE, rec("alter_gmail_send", "appr_group"));
    lock.set("slack:dm:D999", ALICE, rec("alter_gmail_send", "appr_dm"));
    expect(lock.activeFor(SESSION, ALICE)?.approvalId).toBe("appr_group");
    expect(lock.activeFor("slack:dm:D999", ALICE)?.approvalId).toBe("appr_dm");
  });

  it("purges per (session,user) — Alice's expiry doesn't drop Bob's lock", () => {
    const now = Date.now();
    lock.set(SESSION, ALICE, {
      ...rec("alter_gmail_send", "appr_alice"),
      createdAt: now - 2 * 60 * 60 * 1000,
      expiresAtMs: now - 60 * 60 * 1000,
    });
    lock.set(SESSION, BOB, rec("alter_slack_post_message", "appr_bob"));
    // Alice's is stale and self-purges...
    expect(lock.activeFor(SESSION, ALICE, now)).toBeUndefined();
    // ...Bob's is untouched.
    expect(lock.activeFor(SESSION, BOB, now)?.approvalId).toBe("appr_bob");
  });
});

describe("the store makes the bug unrepresentable", () => {
  it("cannot be queried without naming a user (missing arg fails closed, never leaks)", () => {
    // The compile-time guardrail — `activeFor(sessionId)` with one arg must not
    // typecheck — is enforced by `pnpm typecheck` on src/ (a 1-arg call there
    // fails the build). It is NOT enforced here: tsconfig excludes tests/ and
    // vitest strips types without checking, so a `@ts-expect-error` directive
    // would verify nothing. This asserts the RUNTIME half instead: if a caller
    // bypasses the types and passes no user, the store must fail closed — throw
    // rather than hand back whatever lock the session holds.
    lock.set(SESSION, ALICE, rec("alter_gmail_send", "appr_1"));
    const noUser = undefined as unknown as string;
    // node:sqlite refuses to bind `undefined`, so the query throws before it can
    // return a row. The property that matters: an un-scoped query never yields
    // Alice's record — it errors out.
    expect(() => lock.activeFor(SESSION, noUser)).toThrow();
  });

  it("treats an empty appUserId as its own partition, not a wildcard", () => {
    // Defensive: if a caller ever passed "" it must match nothing real, rather
    // than acting as a match-anything key.
    lock.set(SESSION, ALICE, rec("alter_gmail_send", "appr_alice"));
    expect(lock.activeFor(SESSION, "")).toBeUndefined();
  });
});
