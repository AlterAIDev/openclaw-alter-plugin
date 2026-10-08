import type { ApprovalStatus } from "@alter-ai/alter-sdk";
import { openDatabase } from "./sqlite.js";

/** One approver gate of a multi-party approval: its id and wallet link. */
export interface ApprovalGateLink {
  approvalId: string;
  approvalUrl: string;
}

export interface PendingApprovalRecord {
  approvalId: string;
  approvalUrl: string;
  toolName: string;
  createdAt: number;
  /**
   * Epoch-ms when the approval window closes — `PendingApproval.expires_at`.
   * This is the lock's idle-purge horizon: the lock lives exactly as long as
   * the approval it guards. Optional for backward compatibility (a caller that
   * omits it) — those fall back to `createdAt + maxAgeMs`.
   */
  expiresAtMs?: number;
  /**
   * Every gate of an N-of-N multi-party approval, executor first. Set only when
   * there is more than one: `approvalUrl` alone is the executor gate's link, so
   * without these a replay would strand the other approvers. Absent means a
   * single gate, which `approvalId` / `approvalUrl` already describe.
   */
  gates?: readonly ApprovalGateLink[];
}

/**
 * The gates of a locked approval still waiting on a decision, in order.
 *
 * A single-gate lock is its own link, and the poll isn't consulted. For a
 * multi-party lock without a poll result (the status call failed) every gate
 * is returned: we can't tell which are done. A gate the poll reports as
 * anything but `pending` has been decided and is dropped. If that drops every
 * gate, the ids didn't line up with the poll's, so fall back to all of them
 * rather than show none.
 */
export function outstandingGates(
  lock: PendingApprovalRecord,
  status?: ApprovalStatus,
): ApprovalGateLink[] {
  if (!lock.gates || lock.gates.length <= 1) {
    return [{ approvalId: lock.approvalId, approvalUrl: lock.approvalUrl }];
  }
  const gates = [...lock.gates];
  if (!status) return gates;
  const decided = new Set(
    status.gates.filter((g) => g.status !== "pending").map((g) => g.approvalId),
  );
  const outstanding = gates.filter((g) => !decided.has(g.approvalId));
  return outstanding.length > 0 ? outstanding : gates;
}

/** "1. <url>\n2. <url>" for a list of gate links. */
export function numberedGateLinks(gates: readonly { approvalUrl: string }[]): string {
  return gates.map((g, i) => `${i + 1}. ${g.approvalUrl}`).join("\n");
}

/**
 * Parse the stored `gates_json` column. It's our own write, but a bad value
 * must degrade to the single-link replay, never throw out of a tool call.
 */
function parseGates(raw: string | null): ApprovalGateLink[] | undefined {
  if (raw === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const gates: ApprovalGateLink[] = [];
  for (const g of parsed) {
    if (
      typeof g !== "object" || g === null ||
      typeof (g as { approvalId?: unknown }).approvalId !== "string" ||
      typeof (g as { approvalUrl?: unknown }).approvalUrl !== "string"
    ) {
      return undefined;
    }
    const { approvalId, approvalUrl } = g as ApprovalGateLink;
    gates.push({ approvalId, approvalUrl });
  }
  return gates.length > 1 ? gates : undefined;
}

/**
 * Wallet approvals are gated locally with a lock so the agent doesn't queue
 * up a second write call while the user is still deciding on the first.
 *
 * ## Why every method takes an appUserId
 *
 * The lock is keyed on `(sessionId, appUserId)`, and BOTH halves are load-bearing.
 *
 * A session is not a user. A Slack group DM or channel is ONE session shared by
 * every participant, so a session-only key (schema v1-v4) made this table a
 * cross-user disclosure channel: the caller that finds a lock is handed the
 * approval's wallet URL and tool name, and `/alter status clear` would clear
 * whatever lock it found. In a group DM that meant any participant could read —
 * and clear — any other participant's pending approval. That is the bug this
 * signature exists to make unrepresentable: you cannot query the lock without
 * saying whose lock you want.
 *
 * `appUserId` MUST come from the sealed identity link (`IdentityStore.get`),
 * never from the model or from a tool parameter. Callers must therefore resolve
 * identity BEFORE consulting the lock — see the gate order in tools/base.ts.
 *
 * ## Lifecycle
 *
 * SET when `proxyRequest` returns a `PendingApproval` (`tools/base.ts`). CLEARED
 * when a subsequent tool call — or `/alter status` — polls the approval's real
 * status via `agent.getApprovalStatus(...)` and finds it terminal (executed /
 * denied / expired / failed). Alter executes an approved request server-side and
 * never re-invokes the plugin, so that poll is the only reliable resolution
 * signal; there is no in-band callback to clear the lock on.
 *
 * The idle backstop: if the user approves (or lets the approval sit) and never
 * calls another tool, nothing triggers the poll, so `activeFor` self-purges the
 * lock once it outlives its window. The purge horizon is the LATER of a fixed
 * `DEFAULT_MAX_AGE_MS` floor and the approval's real `expires_at`. Alter's
 * approval window is operator-configurable (1 hour by default): tracking the real
 * expiry stops a longer window from purging a still-pending lock early (which
 * would let a duplicate approval be minted), while the fixed floor keeps a fresh
 * lock alive on a shorter window so a retry shortly after expiry can still poll
 * the real terminal instead of silently minting a duplicate.
 * `/alter status clear` is the manual escape hatch.
 */
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000;

export class PendingApprovalLock {
  constructor(
    private readonly workspaceDir: string,
    private readonly maxAgeMs: number = DEFAULT_MAX_AGE_MS,
  ) {}

  /**
   * The caller's own active lock, or undefined.
   *
   * Never returns another user's lock, even in a shared session — that is the
   * whole point of the appUserId parameter.
   */
  activeFor(
    sessionId: string,
    appUserId: string,
    nowMs = Date.now(),
  ): PendingApprovalRecord | undefined {
    const db = openDatabase(this.workspaceDir);
    const row = db
      .prepare(
        `SELECT approval_id, approval_url, tool_name, created_at_ms, expires_at_ms, gates_json
         FROM pending_approval_lock WHERE session_id = ? AND app_user_id = ?`,
      )
      .get(sessionId, appUserId) as
      | {
          approval_id: string;
          approval_url: string;
          tool_name: string;
          created_at_ms: number;
          expires_at_ms: number | null;
          gates_json: string | null;
        }
      | undefined;
    if (!row) return undefined;
    // Idle-purge horizon: the LATER of the fixed maxAgeMs backstop and the
    // approval's own expiry. Taking the max (not expiry alone) is deliberate:
    //  - `expires_at` extends the horizon so a still-pending approval on a long,
    //    operator-configured window is never purged early (which would let a
    //    duplicate approval be minted — the hazard the lock prevents);
    //  - the maxAgeMs floor keeps a fresh lock alive even on a SHORT window, so a
    //    retry shortly after the window closes still finds the lock and lets the
    //    poll report the real terminal (e.g. an approval executed just before
    //    expiry) instead of silently minting a duplicate.
    const horizonMs = Math.max(row.created_at_ms + this.maxAgeMs, row.expires_at_ms ?? 0);
    if (nowMs >= horizonMs) {
      // Auto-purge: the lock outlived the approval window, so it's definitely
      // stale. Removing it here lets the next tool call proceed without
      // requiring the user to run /alter status clear.
      db.prepare(
        `DELETE FROM pending_approval_lock WHERE session_id = ? AND app_user_id = ?`,
      ).run(sessionId, appUserId);
      return undefined;
    }
    const gates = parseGates(row.gates_json);
    return {
      approvalId: row.approval_id,
      approvalUrl: row.approval_url,
      toolName: row.tool_name,
      createdAt: row.created_at_ms,
      expiresAtMs: row.expires_at_ms ?? undefined,
      ...(gates ? { gates } : {}),
    };
  }

  /**
   * Returns `true` if a fresh active lock already existed for THIS user and was
   * preserved (caller MUST surface the pending approval instead of silently
   * overwriting). Returns `false` when the lock was newly written.
   *
   * Only overwrites locks past their approval window (auto-purged by
   * `activeFor`); rejects if a fresh active lock exists. Another user's lock in
   * the same session is invisible here and cannot be overwritten.
   */
  set(
    sessionId: string,
    appUserId: string,
    rec: PendingApprovalRecord,
    nowMs = Date.now(),
  ): boolean {
    const db = openDatabase(this.workspaceDir);
    const active = this.activeFor(sessionId, appUserId, nowMs);
    if (active && active.approvalId !== rec.approvalId) {
      // A different active lock exists — refuse and let the caller surface
      // the pending approval back to the user.
      return true;
    }
    db.prepare(
      `INSERT INTO pending_approval_lock
        (session_id, app_user_id, approval_id, approval_url, tool_name, created_at_ms, expires_at_ms, gates_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, app_user_id) DO UPDATE SET
         approval_id = excluded.approval_id,
         approval_url = excluded.approval_url,
         tool_name = excluded.tool_name,
         created_at_ms = excluded.created_at_ms,
         expires_at_ms = excluded.expires_at_ms,
         gates_json = excluded.gates_json`,
    ).run(
      sessionId,
      appUserId,
      rec.approvalId,
      rec.approvalUrl,
      rec.toolName,
      rec.createdAt,
      rec.expiresAtMs ?? null,
      rec.gates && rec.gates.length > 1
        ? JSON.stringify(rec.gates.map((g) => ({ approvalId: g.approvalId, approvalUrl: g.approvalUrl })))
        : null,
    );
    return false;
  }

  /** Clear ONLY the caller's own lock. Never another participant's. */
  clear(sessionId: string, appUserId: string): void {
    const db = openDatabase(this.workspaceDir);
    db.prepare(
      `DELETE FROM pending_approval_lock WHERE session_id = ? AND app_user_id = ?`,
    ).run(sessionId, appUserId);
  }
}
