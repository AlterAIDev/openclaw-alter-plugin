import { randomUUID } from "node:crypto";
import { openDatabase } from "../sqlite.js";
import { seal, open as openSeal, type AeadAad } from "../crypto/jwt-at-rest.js";

export interface IdentityLink {
  channelKind: string;
  channelUserId: string;
  appUserId: string;
  idpSub: string;
  jwt: string;
  jwtExpiresAt: number;
  rowId: string;
}

export interface UpsertResult {
  status: "inserted" | "refreshed" | "rejected_collision";
  existingAppUserId?: string;
}

export class IdentityStore {
  constructor(private readonly workspaceDir: string, private readonly key: Buffer) {}

  private aad(channelKind: string, channelUserId: string, rowId: string): AeadAad {
    return { channelKind, channelUserId, rowId };
  }

  get(channelKind: string, channelUserId: string): IdentityLink | undefined {
    const db = openDatabase(this.workspaceDir);
    const row = db
      .prepare(
        `SELECT app_user_id, idp_sub, jwt_ciphertext, jwt_nonce, jwt_expires_at_ms,
                created_at_ms FROM identity_link
         WHERE channel_kind = ? AND channel_user_id = ?`,
      )
      .get(channelKind, channelUserId) as
      | {
          app_user_id: string;
          idp_sub: string;
          jwt_ciphertext: Uint8Array;
          jwt_nonce: Uint8Array;
          jwt_expires_at_ms: number;
          created_at_ms: number;
        }
      | undefined;
    if (!row) return undefined;
    const rowId = String(row.created_at_ms);
    const jwt = openSeal(
      { ciphertext: Buffer.from(row.jwt_ciphertext), nonce: Buffer.from(row.jwt_nonce) },
      this.key,
      this.aad(channelKind, channelUserId, rowId),
    );
    return {
      channelKind,
      channelUserId,
      appUserId: row.app_user_id,
      idpSub: row.idp_sub,
      jwt,
      jwtExpiresAt: row.jwt_expires_at_ms,
      rowId,
    };
  }

  upsert(args: {
    channelKind: string;
    channelUserId: string;
    appUserId: string;
    idpSub: string;
    jwt: string;
    jwtExpiresAt: number;
  }): UpsertResult {
    // Concurrency: two simultaneous first-sign-ins for the same channel-user
    // both see "no existing row" in a naive check-then-insert, and the loser
    // hits PRIMARY KEY conflict. We INSERT first with ON CONFLICT DO NOTHING
    // then re-read; if the row that landed is ours, status=inserted; if a
    // different idpSub got there first, status=rejected_collision; if the
    // same idpSub got there first (or had already existed), this becomes a
    // refresh against the canonical row.
    //
    // The entire INSERT/SELECT/UPDATE sequence runs inside BEGIN IMMEDIATE
    // so that a third writer cannot interleave between our SELECT and
    // UPDATE — without the transaction, an `unlink` racing with us could
    // make our UPDATE silently affect zero rows while we'd still return
    // "refreshed". BEGIN IMMEDIATE takes the RESERVED lock up-front, which
    // pairs with `PRAGMA busy_timeout` to serialize concurrent upserts.
    const db = openDatabase(this.workspaceDir);
    const now = Date.now();

    db.prepare(`BEGIN IMMEDIATE`).run();
    let committed = false;
    try {
      // Best-effort INSERT — the seal here uses `now` as the row-id, which
      // is only the canonical row-id if our INSERT wins. We re-seal below
      // against whichever row actually persisted.
      const speculativeSealed = seal(
        args.jwt,
        this.key,
        this.aad(args.channelKind, args.channelUserId, String(now)),
      );
      const insertRes = db
        .prepare(
          `INSERT INTO identity_link
            (channel_kind, channel_user_id, app_user_id, idp_sub,
             jwt_ciphertext, jwt_nonce, jwt_expires_at_ms, created_at_ms, updated_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(channel_kind, channel_user_id) DO NOTHING`,
        )
        .run(
          args.channelKind,
          args.channelUserId,
          args.appUserId,
          args.idpSub,
          speculativeSealed.ciphertext,
          speculativeSealed.nonce,
          args.jwtExpiresAt,
          now,
          now,
        );
      // `changes` is 1 when the row actually landed, 0 when a conflicting
      // row already existed. This is the only reliable signal — comparing
      // `created_at_ms === now` is wrong because two upserts called
      // back-to-back in the same millisecond would falsely report the
      // second as "inserted".
      const inserted = Number(insertRes.changes) === 1;

      const canonical = db
        .prepare(
          `SELECT app_user_id, idp_sub, created_at_ms FROM identity_link
           WHERE channel_kind = ? AND channel_user_id = ?`,
        )
        .get(args.channelKind, args.channelUserId) as
        | { app_user_id: string; idp_sub: string; created_at_ms: number }
        | undefined;

      if (!canonical) {
        // Should be impossible inside BEGIN IMMEDIATE — we either inserted
        // or another writer's INSERT was already visible. The only way to
        // reach here is data corruption (DB file replaced mid-transaction).
        throw new Error(
          "[alter] identity_link row vanished between INSERT and SELECT (DB corruption?)",
        );
      }

      if (canonical.idp_sub !== args.idpSub) {
        db.prepare(`COMMIT`).run();
        committed = true;
        return { status: "rejected_collision", existingAppUserId: canonical.app_user_id };
      }

      if (inserted) {
        db.prepare(`COMMIT`).run();
        committed = true;
        return { status: "inserted" };
      }

      // Conflict path: a row with the same (channel_kind, channel_user_id)
      // and matching idpSub already existed. Refresh the JWT in place,
      // re-sealing against the canonical row-id so the AAD continues to
      // authenticate.
      const rowId = String(canonical.created_at_ms);
      const sealed = seal(
        args.jwt,
        this.key,
        this.aad(args.channelKind, args.channelUserId, rowId),
      );
      const updateRes = db
        .prepare(
          `UPDATE identity_link
           SET jwt_ciphertext = ?, jwt_nonce = ?, jwt_expires_at_ms = ?, updated_at_ms = ?
           WHERE channel_kind = ? AND channel_user_id = ?`,
        )
        .run(
          sealed.ciphertext,
          sealed.nonce,
          args.jwtExpiresAt,
          now,
          args.channelKind,
          args.channelUserId,
        );
      if (Number(updateRes.changes) !== 1) {
        // Inside BEGIN IMMEDIATE this is "impossible" unless the row was
        // deleted concurrently while we held the lock — which SQLite's
        // serialization rules out. Treat as DB corruption.
        throw new Error(
          "[alter] identity_link UPDATE affected 0 rows inside BEGIN IMMEDIATE (DB corruption?)",
        );
      }
      db.prepare(`COMMIT`).run();
      committed = true;
      return { status: "refreshed" };
    } finally {
      if (!committed) {
        try {
          db.prepare(`ROLLBACK`).run();
        } catch {
          // Already rolled back (e.g. SQLite auto-rolled on error). Safe.
        }
      }
    }
  }

  unlink(channelKind: string, channelUserId: string): boolean {
    const db = openDatabase(this.workspaceDir);
    const res = db
      .prepare(
        `DELETE FROM identity_link
         WHERE channel_kind = ? AND channel_user_id = ?`,
      )
      .run(channelKind, channelUserId);
    return Number(res.changes) > 0;
  }
}

export function newRowId(): string {
  return randomUUID();
}
