import { createHmac } from "node:crypto";
import { ConnectTimeoutError, type App, type AuthResult } from "@alter-ai/alter-sdk";
import { openDatabase } from "../sqlite.js";
import { seal, open as openSeal, type AeadAad } from "../crypto/jwt-at-rest.js";

const SESSION_TTL_MS = 10 * 60 * 1000; // mirrors Alter's hosted sign-in window

/**
 * End-user sign-in for chat-channel users, built on the public Alter SDK.
 *
 * The plugin hands a remote user a one-time sign-in link and waits for the
 * resulting IDP JWT in the background. Two SDK primitives do the work:
 *
 *   - `App.createAuthSession()` mints `{ authUrl, sessionToken, … }` without
 *     opening a browser or mutating instance state — safe for our shared,
 *     multi-tenant App client. We persist the `sessionToken` (sealed) so a
 *     pending sign-in survives a plugin/gateway restart.
 *   - `App.pollAuthSession(sessionToken, { timeoutMs })` blocks until the user
 *     completes IDP login (retrying transient backend blips internally) and
 *     returns the user's JWT, or throws on a terminal error / timeout.
 *
 * This module supplies the two pieces the SDK leaves to the consumer:
 * {@link AuthSessionStore} (encrypted-at-rest persistence of in-flight
 * sessions) and {@link AuthPoller} (a resumable background poll loop).
 */

export interface PendingAuthSession {
  sessionToken: string;
  channelKind: string;
  channelUserId: string;
  chatSessionId: string;
  authUrl: string;
  iatMs: number;
  ttlMs: number;
  status: "pending" | "completed" | "expired" | "failed";
}

/**
 * Persistence for in-flight `/alter login` sessions.
 *
 * `session_token` is a bearer credential for `App.pollAuthSession` —
 * presenting it retrieves the completed user JWT. Storing it in plaintext on disk
 * for the 10-minute auth window would let any unix-local attacker (or anyone
 * with a backup snapshot) race the legitimate user and steal the JWT. So:
 *
 *   - The on-disk PRIMARY KEY is `HMAC(hmacSecret, session_token)` — a
 *     lookup hash that lets us find the row without revealing the token.
 *   - `session_token` and `auth_url` are AES-256-GCM sealed with the same
 *     `dbEncryptionKey` used by IdentityStore, AAD-bound to the row's hash
 *     + channel context so row-swap attacks can't substitute one row's
 *     ciphertext for another.
 *
 * The cleartext only ever lives in process memory while a poll iteration is
 * running.
 */
export class AuthSessionStore {
  constructor(
    private readonly workspaceDir: string,
    private readonly dbEncryptionKey: Buffer,
    private readonly lookupHmacSecret: Buffer,
  ) {
    if (dbEncryptionKey.length !== 32) {
      throw new Error("AuthSessionStore: dbEncryptionKey must be 32 bytes");
    }
    if (lookupHmacSecret.length < 32) {
      throw new Error("AuthSessionStore: lookupHmacSecret must be >=32 bytes");
    }
  }

  private lookupKey(sessionToken: string): Buffer {
    return createHmac("sha256", this.lookupHmacSecret).update(sessionToken).digest();
  }

  private aad(hash: Buffer, field: "tok" | "url", channelKind: string, channelUserId: string): AeadAad {
    // Bind the ciphertext to (row hash, field name, channel context) so a
    // row-swap or field-swap attack against another row's ciphertext fails
    // GCM verification.
    return {
      channelKind: `__pending_auth:${field}:${channelKind}`,
      channelUserId,
      rowId: hash.toString("hex"),
    };
  }

  insert(s: PendingAuthSession): void {
    const db = openDatabase(this.workspaceDir);
    const hash = this.lookupKey(s.sessionToken);
    const tokSealed = seal(
      s.sessionToken,
      this.dbEncryptionKey,
      this.aad(hash, "tok", s.channelKind, s.channelUserId),
    );
    const urlSealed = seal(
      s.authUrl,
      this.dbEncryptionKey,
      this.aad(hash, "url", s.channelKind, s.channelUserId),
    );
    db.prepare(
      `INSERT INTO pending_auth_sessions
        (session_token_hash, session_token_ct, session_token_nonce,
         channel_kind, channel_user_id, chat_session_id,
         auth_url_ct, auth_url_nonce, iat_ms, ttl_ms, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      hash,
      tokSealed.ciphertext,
      tokSealed.nonce,
      s.channelKind,
      s.channelUserId,
      s.chatSessionId,
      urlSealed.ciphertext,
      urlSealed.nonce,
      s.iatMs,
      s.ttlMs,
      s.status,
    );
  }

  get(sessionToken: string): PendingAuthSession | undefined {
    const db = openDatabase(this.workspaceDir);
    const hash = this.lookupKey(sessionToken);
    const row = db
      .prepare(
        `SELECT session_token_ct, session_token_nonce,
                channel_kind, channel_user_id, chat_session_id,
                auth_url_ct, auth_url_nonce,
                iat_ms, ttl_ms, status
         FROM pending_auth_sessions WHERE session_token_hash = ?`,
      )
      .get(hash) as
      | {
          session_token_ct: Uint8Array;
          session_token_nonce: Uint8Array;
          channel_kind: string;
          channel_user_id: string;
          chat_session_id: string;
          auth_url_ct: Uint8Array;
          auth_url_nonce: Uint8Array;
          iat_ms: number;
          ttl_ms: number;
          status: string;
        }
      | undefined;
    if (!row) return undefined;
    return this.decryptRow(hash, row);
  }

  setStatus(sessionToken: string, status: PendingAuthSession["status"]): void {
    const db = openDatabase(this.workspaceDir);
    db.prepare(
      `UPDATE pending_auth_sessions SET status = ? WHERE session_token_hash = ?`,
    ).run(status, this.lookupKey(sessionToken));
  }

  delete(sessionToken: string): void {
    const db = openDatabase(this.workspaceDir);
    db.prepare(`DELETE FROM pending_auth_sessions WHERE session_token_hash = ?`).run(
      this.lookupKey(sessionToken),
    );
  }

  listPending(nowMs: number): PendingAuthSession[] {
    const db = openDatabase(this.workspaceDir);
    const rows = db
      .prepare(
        `SELECT session_token_hash,
                session_token_ct, session_token_nonce,
                channel_kind, channel_user_id, chat_session_id,
                auth_url_ct, auth_url_nonce,
                iat_ms, ttl_ms, status
         FROM pending_auth_sessions WHERE status = 'pending'`,
      )
      .all() as Array<{
      session_token_hash: Uint8Array;
      session_token_ct: Uint8Array;
      session_token_nonce: Uint8Array;
      channel_kind: string;
      channel_user_id: string;
      chat_session_id: string;
      auth_url_ct: Uint8Array;
      auth_url_nonce: Uint8Array;
      iat_ms: number;
      ttl_ms: number;
      status: string;
    }>;
    const out: PendingAuthSession[] = [];
    for (const row of rows) {
      if (nowMs > row.iat_ms + row.ttl_ms) continue;
      try {
        out.push(this.decryptRow(Buffer.from(row.session_token_hash), row));
      } catch {
        // Corrupted/unreadable row — skip silently. The poll loop will time
        // out the session naturally and operators can prune stale rows.
      }
    }
    return out;
  }

  pruneExpired(nowMs: number): number {
    const db = openDatabase(this.workspaceDir);
    const res = db
      .prepare(
        `DELETE FROM pending_auth_sessions
         WHERE status != 'pending' OR (iat_ms + ttl_ms) < ?`,
      )
      .run(nowMs);
    return Number(res.changes);
  }

  private decryptRow(
    hash: Buffer,
    row: {
      session_token_ct: Uint8Array;
      session_token_nonce: Uint8Array;
      channel_kind: string;
      channel_user_id: string;
      chat_session_id: string;
      auth_url_ct: Uint8Array;
      auth_url_nonce: Uint8Array;
      iat_ms: number;
      ttl_ms: number;
      status: string;
    },
  ): PendingAuthSession {
    const sessionToken = openSeal(
      {
        ciphertext: Buffer.from(row.session_token_ct),
        nonce: Buffer.from(row.session_token_nonce),
      },
      this.dbEncryptionKey,
      this.aad(hash, "tok", row.channel_kind, row.channel_user_id),
    );
    const authUrl = openSeal(
      {
        ciphertext: Buffer.from(row.auth_url_ct),
        nonce: Buffer.from(row.auth_url_nonce),
      },
      this.dbEncryptionKey,
      this.aad(hash, "url", row.channel_kind, row.channel_user_id),
    );
    return {
      sessionToken,
      channelKind: row.channel_kind,
      channelUserId: row.channel_user_id,
      chatSessionId: row.chat_session_id,
      authUrl,
      iatMs: row.iat_ms,
      ttlMs: row.ttl_ms,
      status: row.status as PendingAuthSession["status"],
    };
  }
}

export interface AuthPollerCallbacks {
  /**
   * May be synchronous: the poller awaits it either way, and a throw or a
   * rejection both reach `onCompletedError`.
   */
  onCompleted: (
    s: PendingAuthSession,
    userToken: string,
    userInfo: Record<string, unknown>,
  ) => void | Promise<void>;
  onExpired?: (s: PendingAuthSession) => void;
  onFailed?: (s: PendingAuthSession, reason?: string) => void;
  /**
   * Called when `onCompleted` throws. The pending row is still deleted after
   * this fires — the auth session is single-use and the JWT can't be replayed
   * — so callers should treat this as a terminal failure (operator must
   * inspect why the identity persist failed). Default is silent; in
   * production, wire this to your plugin logger.
   */
  onCompletedError?: (s: PendingAuthSession, err: unknown) => void;
}

export class AuthPoller {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly app: App,
    private readonly store: AuthSessionStore,
    private readonly callbacks: AuthPollerCallbacks,
  ) {}

  start(s: PendingAuthSession): void {
    if (this.active.has(s.sessionToken)) return;
    const ctrl = new AbortController();
    this.active.set(s.sessionToken, ctrl);
    void this.runOnce(s, ctrl.signal).finally(() => {
      this.active.delete(s.sessionToken);
    });
  }

  cancel(sessionToken: string): void {
    const ctrl = this.active.get(sessionToken);
    if (ctrl) ctrl.abort();
  }

  /**
   * Stop every running loop, e.g. when the gateway shuts down. A stopped loop
   * writes nothing, whatever its poll later returns: the row stays pending
   * for `resumePending` on the next boot.
   */
  stopAll(): void {
    for (const ctrl of this.active.values()) ctrl.abort();
  }

  resumePending(nowMs = Date.now()): number {
    const pending = this.store.listPending(nowMs);
    for (const s of pending) this.start(s);
    return pending.length;
  }

  /**
   * Drive one sign-in session to a terminal state. `App.pollAuthSession`
   * owns the wait: it blocks until the user completes IDP login (retrying
   * transient backend blips internally) and resolves with the JWT, or throws
   * on a terminal IDP error / timeout. We bound the wait by the session's
   * remaining TTL so a never-completed sign-in is reaped instead of holding a
   * connection open indefinitely.
   */
  private async runOnce(s: PendingAuthSession, signal: AbortSignal): Promise<void> {
    const fresh = this.store.get(s.sessionToken);
    if (!fresh || fresh.status !== "pending") return;

    const remainingMs = fresh.iatMs + fresh.ttlMs - Date.now();
    if (remainingMs <= 0) {
      this.store.setStatus(fresh.sessionToken, "expired");
      this.callbacks.onExpired?.(fresh);
      return;
    }

    let result: AuthResult;
    try {
      result = await this.app.pollAuthSession(fresh.sessionToken, {
        timeoutMs: remainingMs,
      });
    } catch (err) {
      // Cancelled (e.g. plugin shutdown) — leave the row pending so
      // `resumePending` re-issues the poll on the next boot.
      if (signal.aborted) return;
      // A timed-out poll means the user never finished signing in; reap the
      // session as expired so the next attempt mints a fresh one.
      if (err instanceof ConnectTimeoutError) {
        this.store.setStatus(fresh.sessionToken, "expired");
        this.callbacks.onExpired?.(fresh);
        return;
      }
      this.store.setStatus(fresh.sessionToken, "failed");
      this.callbacks.onFailed?.(fresh, err instanceof Error ? err.message : String(err));
      return;
    }
    // Stopped while the poll was in flight (the SDK poll can't be aborted):
    // leave the row pending, as above. The plugin instance that resumes it
    // persists the sign-in, not this stopped one.
    if (signal.aborted) return;

    this.store.setStatus(fresh.sessionToken, "completed");
    try {
      await this.callbacks.onCompleted(fresh, result.userToken, result.userInfo);
    } catch (err) {
      // Identity persist failed — surface to the operator. The pending row is
      // still deleted in `finally` because the JWT was already burned on the
      // Alter side; we cannot retry this exact session.
      this.callbacks.onCompletedError?.(fresh, err);
    } finally {
      this.store.delete(fresh.sessionToken);
    }
  }
}

export const AUTH_SESSION_DEFAULT_TTL_MS = SESSION_TTL_MS;
