import { openDatabase } from "../sqlite.js";

export interface QuotaCaps {
  inputTokensPerDay: number;
  outputTokensPerDay: number;
}

function dayKeyUtc(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export class RateLimitStore {
  constructor(private readonly workspaceDir: string, private readonly caps: QuotaCaps) {}

  bindSession(sessionId: string, appUserId: string): void {
    const db = openDatabase(this.workspaceDir);
    db.prepare(
      `INSERT INTO session_to_user (session_id, app_user_id, updated_at_ms)
       VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         app_user_id = excluded.app_user_id,
         updated_at_ms = excluded.updated_at_ms`,
    ).run(sessionId, appUserId, Date.now());
  }

  appUserForSession(sessionId: string): string | undefined {
    const db = openDatabase(this.workspaceDir);
    const row = db
      .prepare(`SELECT app_user_id FROM session_to_user WHERE session_id = ?`)
      .get(sessionId) as { app_user_id: string } | undefined;
    return row?.app_user_id;
  }

  forgetSession(sessionId: string): void {
    const db = openDatabase(this.workspaceDir);
    db.prepare(`DELETE FROM session_to_user WHERE session_id = ?`).run(sessionId);
  }

  add(appUserId: string, inputTokens: number, outputTokens: number, nowMs = Date.now()): void {
    const day = dayKeyUtc(nowMs);
    const db = openDatabase(this.workspaceDir);
    db.prepare(
      `INSERT INTO rate_limit_counter (app_user_id, day_utc, input_tokens, output_tokens)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(app_user_id, day_utc) DO UPDATE SET
         input_tokens = input_tokens + excluded.input_tokens,
         output_tokens = output_tokens + excluded.output_tokens`,
    ).run(appUserId, day, Math.max(0, inputTokens), Math.max(0, outputTokens));
  }

  isOverQuota(appUserId: string, nowMs = Date.now()): boolean {
    const day = dayKeyUtc(nowMs);
    const db = openDatabase(this.workspaceDir);
    const row = db
      .prepare(
        `SELECT input_tokens, output_tokens FROM rate_limit_counter
         WHERE app_user_id = ? AND day_utc = ?`,
      )
      .get(appUserId, day) as { input_tokens: number; output_tokens: number } | undefined;
    if (!row) return false;
    return (
      row.input_tokens >= this.caps.inputTokensPerDay ||
      row.output_tokens >= this.caps.outputTokensPerDay
    );
  }
}
