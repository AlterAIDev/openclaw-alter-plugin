import { openDatabase } from "../sqlite.js";

export interface PendingConnect {
  csrfNonce: string;
  sessionId: string;
  appUserId: string;
  provider: string;
  iatMs: number;
  ttlMs: number;
}

export class PendingConnectsStore {
  constructor(private readonly workspaceDir: string) {}

  insert(pc: PendingConnect): void {
    const db = openDatabase(this.workspaceDir);
    db.prepare(
      `INSERT INTO pending_connects
        (csrf_nonce, session_id, app_user_id, provider, iat_ms, ttl_ms, consumed)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    ).run(pc.csrfNonce, pc.sessionId, pc.appUserId, pc.provider, pc.iatMs, pc.ttlMs);
  }

  consume(csrfNonce: string, nowMs: number): PendingConnect | undefined {
    const db = openDatabase(this.workspaceDir);
    const row = db
      .prepare(
        `SELECT csrf_nonce, session_id, app_user_id, provider, iat_ms, ttl_ms, consumed
         FROM pending_connects WHERE csrf_nonce = ?`,
      )
      .get(csrfNonce) as
      | {
          csrf_nonce: string;
          session_id: string;
          app_user_id: string;
          provider: string;
          iat_ms: number;
          ttl_ms: number;
          consumed: number;
        }
      | undefined;
    if (!row) return undefined;
    if (row.consumed === 1) return undefined;
    if (nowMs > row.iat_ms + row.ttl_ms) return undefined;
    const res = db
      .prepare(`UPDATE pending_connects SET consumed = 1 WHERE csrf_nonce = ? AND consumed = 0`)
      .run(csrfNonce);
    if (Number(res.changes) !== 1) return undefined;
    return {
      csrfNonce: row.csrf_nonce,
      sessionId: row.session_id,
      appUserId: row.app_user_id,
      provider: row.provider,
      iatMs: row.iat_ms,
      ttlMs: row.ttl_ms,
    };
  }
}
