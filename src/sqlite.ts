import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";

// Hide `node:sqlite` from build-time bundlers (vite/vitest's resolver doesn't
// know about Node 22+ built-ins). At runtime in Node 22+, this resolves to the
// built-in DatabaseSync class — the public surface of `node:sqlite`.
const _nodeRequire = createRequire(import.meta.url);
type NodeSqliteDatabaseSyncCtor = new (path: string) => {
  prepare: (sql: string) => {
    run: (...params: unknown[]) => { changes: number | bigint };
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
  close: () => void;
};
const { DatabaseSync } = _nodeRequire("node:sqlite") as { DatabaseSync: NodeSqliteDatabaseSyncCtor };
type DatabaseSync = InstanceType<NodeSqliteDatabaseSyncCtor>;

// Cache per workspaceDir. The old single-let cache was first-call-wins: two
// plugins (or two test contexts) calling openDatabase with different
// workspaceDir silently shared the first DB. Keying by path also lets
// `closeDatabase()` close one without affecting others.
const dbs = new Map<string, DatabaseSync>();

/**
 * Bump on any schema change. The migration runner below uses
 * `PRAGMA user_version` to discover the current on-disk version and apply
 * incremental migrations forward. Always migrate forward only — there is no
 * downgrade path.
 *
 * Version log:
 *   v1: initial schema (identity_link + grants + pending_* + rate_limit_*)
 *   v2: encrypt pending_auth_sessions secrets at rest. The old table held
 *       session_token (bearer credential for App.pollAuthSession) and auth_url
 *       in plaintext; the v2 shape keys by HMAC(session_token) and seals
 *       both fields with AES-256-GCM bound to the row's hash AAD.
 *   v3: domain-separate the AEAD keys via HKDF. Pre-v3 ciphertexts in
 *       `identity_link` and `pending_auth_sessions` were sealed with the
 *       master DB key directly; v3 derives a per-context subkey, so old
 *       blobs are unreadable and the migration drops them. Affected users
 *       re-run /alter login. This is a one-time cost for proper key
 *       isolation between identity-JWT and auth-session contexts.
 *   v4: add `pending_approval_lock.expires_at_ms` so the local approval
 *       lock's idle-purge horizon tracks the REAL (operator-configurable)
 *       approval window carried on `PendingApproval.expires_at`, instead of a
 *       hardcoded 1-hour guess. A window longer than that guess would purge a
 *       still-pending lock early and let a duplicate approval be minted — the
 *       exact hazard the lock exists to prevent. Nullable; existing rows fall
 *       back to `created_at_ms + maxAgeMs`.
 *   v5: SECURITY — add `pending_approval_lock.app_user_id` and re-key the table
 *       on `(session_id, app_user_id)`. The v1-v4 table was keyed on
 *       session_id ALONE, and a session is shared by every participant of a
 *       Slack group DM / channel — so one user's pending approval (its wallet
 *       URL and tool name) was served to every other participant, and
 *       `/alter status clear` let any of them clear someone else's lock. The
 *       rows are DROPPED rather than migrated: the old schema never recorded
 *       which user a lock belonged to, so there is nothing to backfill from.
 *       Locks are ephemeral (<=1h), so the cost is that an in-flight approval
 *       loses its local gate once.
 *   v6: add `memories` — per-user agent memory, partitioned by the `user_key`
 *       Alter derives (`alter:user:<app_user_id>`), never by a locally-minted
 *       id. Additive; nothing dropped.
 *   v7: add `pending_approval_lock.gates_json` — every gate's id + wallet link
 *       for an N-of-N multi-party approval. The lock held only the executor
 *       gate's link, so a replay (or `/alter status`) dropped the other
 *       approvers' links after the first message. Nullable and additive:
 *       existing rows and single-gate approvals keep `NULL`.
 */
const SCHEMA_VERSION = 7;

const SCHEMA_STATEMENTS = [
  "PRAGMA journal_mode = WAL",
  // Block-and-wait on contention rather than immediately raising SQLITE_BUSY.
  // Two concurrent plugin processes against the same workspace (e.g. the
  // gateway plus a CLI invocation) would otherwise fail-fast on overlap.
  "PRAGMA busy_timeout = 5000",
  // WAL + synchronous=NORMAL is the recommended pair: durability is fsync-
  // on-checkpoint instead of fsync-per-commit, which is acceptable for our
  // workload (a power loss could lose the last few seconds of writes but
  // not corrupt the DB).
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
  `CREATE TABLE IF NOT EXISTS identity_link (
      channel_kind        TEXT NOT NULL,
      channel_user_id     TEXT NOT NULL,
      app_user_id         TEXT NOT NULL,
      idp_sub             TEXT NOT NULL,
      jwt_ciphertext      BLOB NOT NULL,
      jwt_nonce           BLOB NOT NULL,
      jwt_expires_at_ms   INTEGER NOT NULL,
      created_at_ms       INTEGER NOT NULL,
      updated_at_ms       INTEGER NOT NULL,
      PRIMARY KEY (channel_kind, channel_user_id)
    )`,
  `CREATE TABLE IF NOT EXISTS grants (
      app_user_id   TEXT NOT NULL,
      provider      TEXT NOT NULL,
      grant_id      TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY (app_user_id, provider)
    )`,
  `CREATE TABLE IF NOT EXISTS pending_connects (
      csrf_nonce    TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      app_user_id   TEXT NOT NULL,
      provider      TEXT NOT NULL,
      iat_ms        INTEGER NOT NULL,
      ttl_ms        INTEGER NOT NULL,
      consumed      INTEGER NOT NULL DEFAULT 0
    )`,
  // Keyed on (session_id, app_user_id) — NOT session_id alone.
  //
  // A Slack group DM / channel is ONE session shared by every participant, so a
  // session-only key made a lock a cross-user disclosure channel: the branch
  // that serves it returns the approval's wallet URL + tool name to whoever
  // asked. app_user_id comes from the sealed identity link (never from the
  // model), so it partitions on verified identity.
  `CREATE TABLE IF NOT EXISTS pending_approval_lock (
      session_id    TEXT NOT NULL,
      app_user_id   TEXT NOT NULL,
      approval_id   TEXT NOT NULL,
      approval_url  TEXT NOT NULL,
      tool_name     TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      expires_at_ms INTEGER,
      gates_json    TEXT,
      PRIMARY KEY (session_id, app_user_id)
    )`,
  `CREATE TABLE IF NOT EXISTS rate_limit_counter (
      app_user_id   TEXT NOT NULL,
      day_utc       TEXT NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (app_user_id, day_utc)
    )`,
  `CREATE TABLE IF NOT EXISTS session_to_user (
      session_id    TEXT PRIMARY KEY,
      app_user_id   TEXT NOT NULL,
      updated_at_ms INTEGER NOT NULL
    )`,
  // Per-user agent memory.
  //
  // `user_key` is Alter's `memoryScope().userKey` — `alter:user:<app_user_id>`
  // where app_user_id is Alter's CANONICAL id, resolved server-side from the
  // user's JWT. It is deliberately NOT this plugin's local `app_user_id`
  // (`idp:<sub>`): Alter's guidance is to key external data on app_user_id and
  // "never on email or the raw IDP sub", because a raw sub is not stable across
  // an IdP migration — memory keyed on it would silently orphan.
  //
  // The prefix is Alter's, not ours: it makes a leaked key self-describing and
  // prevents cross-type collisions.
  `CREATE TABLE IF NOT EXISTS memories (
      id            TEXT PRIMARY KEY,
      user_key      TEXT NOT NULL,
      content       TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL
    )`,
  // Every read filters by user_key; without this the isolation query is a scan.
  `CREATE INDEX IF NOT EXISTS idx_memories_user_key ON memories(user_key, created_at_ms DESC)`,
  `CREATE TABLE IF NOT EXISTS pending_auth_sessions (
      session_token_hash    BLOB PRIMARY KEY,
      session_token_ct      BLOB NOT NULL,
      session_token_nonce   BLOB NOT NULL,
      channel_kind          TEXT NOT NULL,
      channel_user_id       TEXT NOT NULL,
      chat_session_id       TEXT NOT NULL,
      auth_url_ct           BLOB NOT NULL,
      auth_url_nonce        BLOB NOT NULL,
      iat_ms                INTEGER NOT NULL,
      ttl_ms                INTEGER NOT NULL,
      status                TEXT NOT NULL DEFAULT 'pending'
    )`,
];

function applyMigrations(db: DatabaseSync): void {
  const row = db.prepare(`PRAGMA user_version`).get() as
    | { user_version?: number }
    | undefined;
  const current = Number(row?.user_version ?? 0);

  // v1 → v2: drop pending_auth_sessions and rebuild via SCHEMA_STATEMENTS
  // below. In-flight sign-in sessions (max 10-min TTL) are lost on upgrade;
  // affected users re-run /alter login. This is a one-time cost for the
  // security upgrade that takes the bearer session_token off plaintext disk.
  if (current < 2) {
    db.prepare(`DROP TABLE IF EXISTS pending_auth_sessions`).run();
  }

  // v2 → v3: domain-separate the AEAD keys via HKDF. Existing ciphertexts in
  // identity_link and pending_auth_sessions were sealed with the master DB
  // key directly; with the new derivation they're unreadable. Drop both
  // tables — affected users re-run /alter login. Grants survive because
  // they're not encrypted (just app_user_id → grant_id mappings).
  if (current < 3) {
    db.prepare(`DROP TABLE IF EXISTS identity_link`).run();
    db.prepare(`DROP TABLE IF EXISTS pending_auth_sessions`).run();
  }

  // v3 → v4: add pending_approval_lock.expires_at_ms in place (the lock rows —
  // per-session, short-lived — must survive, unlike the encrypted tables above,
  // so this is an additive ALTER, not a drop). Only runs when the table already
  // exists (existing DBs); a fresh DB gets the column from SCHEMA_STATEMENTS
  // below. `ADD COLUMN` isn't idempotent, so guard on PRAGMA table_info.
  if (current < 4) {
    const cols = db
      .prepare(`PRAGMA table_info(pending_approval_lock)`)
      .all() as Array<{ name?: string }>;
    if (cols.length > 0 && !cols.some((c) => c.name === "expires_at_ms")) {
      db.prepare(`ALTER TABLE pending_approval_lock ADD COLUMN expires_at_ms INTEGER`).run();
    }
  }

  // v4 → v5: re-key the approval lock on (session_id, app_user_id).
  //
  // DROP, not ALTER. Two reasons, and the first is decisive:
  //   1. There is nothing to backfill FROM. The old rows never recorded which
  //      user the lock belonged to — that omission IS the vulnerability. Any
  //      app_user_id we invented would be a guess, and a wrong guess re-creates
  //      the cross-user leak we're closing.
  //   2. SQLite can't change a PRIMARY KEY in place anyway; it needs a table
  //      rebuild, which for ephemeral rows isn't worth the risk.
  // Cost: an in-flight approval loses its local gate once, so its owner could
  // mint a duplicate. Bounded (locks live <=1h), and strictly better than
  // serving one user's approval URL to another.
  if (current < 5) {
    db.prepare(`DROP TABLE IF EXISTS pending_approval_lock`).run();
  }

  // v6 → v7: add pending_approval_lock.gates_json in place. Same shape as the
  // v4 step: additive, guarded on PRAGMA table_info because ADD COLUMN isn't
  // idempotent, and skipped when the table doesn't exist yet (a fresh DB, or
  // one the v5 step just dropped, gets the column from SCHEMA_STATEMENTS).
  if (current < 7) {
    const cols = db
      .prepare(`PRAGMA table_info(pending_approval_lock)`)
      .all() as Array<{ name?: string }>;
    if (cols.length > 0 && !cols.some((c) => c.name === "gates_json")) {
      db.prepare(`ALTER TABLE pending_approval_lock ADD COLUMN gates_json TEXT`).run();
    }
  }

  for (const stmt of SCHEMA_STATEMENTS) {
    db.prepare(stmt).run();
  }

  if (current !== SCHEMA_VERSION) {
    // PRAGMA user_version doesn't accept bound params — interpolate the
    // integer literal directly. Safe because SCHEMA_VERSION is a const int.
    db.prepare(`PRAGMA user_version = ${SCHEMA_VERSION}`).run();
  }
}

export function openDatabase(workspaceDir: string): DatabaseSync {
  // Normalize the workspace dir so paths like `/foo/./bar`, `/foo/bar/`,
  // and a symlinked version of the same dir all resolve to one cache key
  // (and one DatabaseSync handle). Without this, two callers using
  // different-looking paths to the same directory would each get their own
  // handle and silently diverge on writes routed through the WAL.
  const resolvedDir = canonicalize(workspaceDir);
  const path = join(resolvedDir, ".alter", "plugin.sqlite");
  const cached = dbs.get(path);
  if (cached) return cached;
  // mode 0o700 prevents other unix users on the machine from reading the
  // SQLite file. The file holds AEAD-encrypted JWTs + session-tokens, but
  // metadata (channel kinds, channel user ids, idp_sub, vault key hash)
  // would otherwise be world-readable on default-umask systems.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const fresh = new DatabaseSync(path);
  applyMigrations(fresh);
  dbs.set(path, fresh);
  return fresh;
}

function canonicalize(dir: string): string {
  const abs = resolve(dir);
  try {
    return realpathSync(abs);
  } catch {
    // Workspace dir doesn't exist yet (first run) — fall back to the
    // resolved absolute path. mkdirSync below will create it.
    return abs;
  }
}

/**
 * Close every cached database connection. Tests call this in `afterEach`
 * before deleting the workspace tmpdir; production never calls it.
 */
export function closeDatabase(): void {
  for (const handle of dbs.values()) {
    try {
      handle.close();
    } catch {
      // Best-effort — already-closed handles are fine to ignore.
    }
  }
  dbs.clear();
}
