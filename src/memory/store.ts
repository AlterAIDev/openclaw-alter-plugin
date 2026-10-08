import { randomUUID } from "node:crypto";
import { openDatabase } from "../sqlite.js";

export interface MemoryRow {
  id: string;
  content: string;
  createdAtMs: number;
}

/**
 * Per-user agent memory, partitioned by Alter's `memoryScope().userKey`.
 *
 * EVERY method takes a `userKey` first. That is not ceremony — it is the same
 * discipline the approval lock follows: if a store can be queried without
 * naming whose data you want, sooner or later something queries it without
 * naming whose data it wants. There is deliberately no
 * `list()`, no `searchAll()`, and no way to ask this class a question that isn't
 * scoped to one user.
 *
 * `userKey` MUST come from {@link MemoryScopeResolver} (i.e. from Alter,
 * derived from the user's JWT). Never from the plugin's local `app_user_id`,
 * never from a tool parameter, never from the model.
 */
export class MemoryStore {
  constructor(private readonly workspaceDir: string) {}

  add(userKey: string, content: string, nowMs = Date.now()): MemoryRow {
    assertUserKey(userKey);
    const db = openDatabase(this.workspaceDir);
    const row: MemoryRow = { id: randomUUID(), content, createdAtMs: nowMs };
    db.prepare(
      `INSERT INTO memories (id, user_key, content, created_at_ms) VALUES (?, ?, ?, ?)`,
    ).run(row.id, userKey, content, nowMs);
    return row;
  }

  /**
   * Newest-first memories for this user, optionally filtered by a substring.
   *
   * Deliberately a plain LIKE rather than FTS: `node:sqlite` ships without a
   * guaranteed FTS5, and a silently-absent index would be worse than an honest
   * scan. The per-user row counts here are small (one person's notes), and the
   * `(user_key, created_at_ms)` index means we never scan another user's rows.
   * If this ever needs real ranking, that is a deliberate upgrade, not a
   * surprise.
   */
  search(userKey: string, query: string | undefined, limit = 20): MemoryRow[] {
    assertUserKey(userKey);
    const db = openDatabase(this.workspaceDir);
    const capped = Math.max(1, Math.min(limit, 100));
    const rows = query
      ? (db
          .prepare(
            `SELECT id, content, created_at_ms FROM memories
              WHERE user_key = ? AND content LIKE ? ESCAPE '\\'
              ORDER BY created_at_ms DESC LIMIT ?`,
          )
          .all(userKey, `%${escapeLike(query)}%`, capped) as Array<{
          id: string;
          content: string;
          created_at_ms: number;
        }>)
      : (db
          .prepare(
            `SELECT id, content, created_at_ms FROM memories
              WHERE user_key = ? ORDER BY created_at_ms DESC LIMIT ?`,
          )
          .all(userKey, capped) as Array<{
          id: string;
          content: string;
          created_at_ms: number;
        }>);
    return rows.map((r) => ({ id: r.id, content: r.content, createdAtMs: r.created_at_ms }));
  }

  /**
   * Delete one memory. Scoped by user_key in the WHERE clause, so a caller
   * cannot delete another user's row even knowing its id.
   */
  delete(userKey: string, id: string): boolean {
    assertUserKey(userKey);
    const db = openDatabase(this.workspaceDir);
    const res = db
      .prepare(`DELETE FROM memories WHERE user_key = ? AND id = ?`)
      .run(userKey, id);
    return Number(res.changes) > 0;
  }

  /** Delete everything this user has stored. */
  forgetAll(userKey: string): number {
    assertUserKey(userKey);
    const db = openDatabase(this.workspaceDir);
    const res = db.prepare(`DELETE FROM memories WHERE user_key = ?`).run(userKey);
    return Number(res.changes);
  }

  count(userKey: string): number {
    assertUserKey(userKey);
    const db = openDatabase(this.workspaceDir);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM memories WHERE user_key = ?`)
      .get(userKey) as { n: number };
    return row.n;
  }
}

/**
 * Refuse anything that isn't an Alter-derived user key.
 *
 * An empty string would silently become a shared partition that every
 * unresolved caller lands in — the "defaults to default_user" bug Alter's guide
 * names. The `alter:user:` prefix check makes it impossible to pass the
 * plugin's local `idp:<sub>` id here by mistake, which is the other way this
 * could go quietly wrong.
 */
function assertUserKey(userKey: string): void {
  if (typeof userKey !== "string" || userKey.length === 0) {
    throw new Error("MemoryStore: userKey is required (refusing an unpartitioned write)");
  }
  if (!userKey.startsWith("alter:user:")) {
    throw new Error(
      `MemoryStore: userKey must be Alter's memoryScope().userKey ("alter:user:…"), got "${userKey.slice(0, 24)}". ` +
        "The plugin's local app_user_id (idp:<sub>) is NOT a valid partition key — see src/memory/scope.ts.",
    );
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
