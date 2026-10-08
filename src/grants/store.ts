import { openDatabase } from "../sqlite.js";

export class GrantsStore {
  constructor(private readonly workspaceDir: string) {}

  get(appUserId: string, provider: string): string | undefined {
    const db = openDatabase(this.workspaceDir);
    const row = db
      .prepare(`SELECT grant_id FROM grants WHERE app_user_id = ? AND provider = ?`)
      .get(appUserId, provider) as { grant_id: string } | undefined;
    return row?.grant_id;
  }

  upsert(appUserId: string, provider: string, grantId: string): void {
    const db = openDatabase(this.workspaceDir);
    db.prepare(
      `INSERT INTO grants (app_user_id, provider, grant_id, created_at_ms)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(app_user_id, provider) DO UPDATE SET grant_id = excluded.grant_id`,
    ).run(appUserId, provider, grantId, Date.now());
  }

  delete(appUserId: string, provider: string): void {
    const db = openDatabase(this.workspaceDir);
    db.prepare(`DELETE FROM grants WHERE app_user_id = ? AND provider = ?`).run(
      appUserId,
      provider,
    );
  }

  listForUser(appUserId: string): Array<{ provider: string; grantId: string }> {
    const db = openDatabase(this.workspaceDir);
    const rows = db
      .prepare(`SELECT provider, grant_id FROM grants WHERE app_user_id = ?`)
      .all(appUserId) as Array<{ provider: string; grant_id: string }>;
    return rows.map((r) => ({ provider: r.provider, grantId: r.grant_id }));
  }
}
