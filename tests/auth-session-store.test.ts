import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTH_SESSION_DEFAULT_TTL_MS,
  AuthSessionStore,
  type PendingAuthSession,
} from "../src/identity/auth-session.js";
import { closeDatabase } from "../src/sqlite.js";

const DB_KEY = randomBytes(32);
const HMAC_SECRET = randomBytes(32);

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "alter-as-"));
});
afterEach(() => {
  closeDatabase();
  rmSync(tmp, { recursive: true, force: true });
});

function makePending(overrides: Partial<PendingAuthSession> = {}): PendingAuthSession {
  return {
    sessionToken: `secret-bearer-${Math.random().toString(36).slice(2)}`,
    channelKind: "slack",
    channelUserId: "U1",
    chatSessionId: "sess-1",
    authUrl: "https://clerk.example/sign-in?ott=DO_NOT_LOG_ME_xyz",
    iatMs: Date.now(),
    ttlMs: AUTH_SESSION_DEFAULT_TTL_MS,
    status: "pending",
    ...overrides,
  };
}

describe("AuthSessionStore — AEAD-at-rest", () => {
  it("round-trips a session through insert → get", () => {
    const store = new AuthSessionStore(tmp, DB_KEY, HMAC_SECRET);
    const s = makePending();
    store.insert(s);
    const read = store.get(s.sessionToken);
    expect(read).toBeDefined();
    expect(read?.sessionToken).toBe(s.sessionToken);
    expect(read?.authUrl).toBe(s.authUrl);
    expect(read?.channelKind).toBe("slack");
  });

  it("the on-disk SQLite file contains NEITHER plaintext session_token NOR auth_url", () => {
    const store = new AuthSessionStore(tmp, DB_KEY, HMAC_SECRET);
    const s = makePending({
      sessionToken: "PLAINTEXT_SESSION_TOKEN_LEAK_PROBE",
      authUrl: "https://example.test/PLAINTEXT_AUTH_URL_LEAK_PROBE",
    });
    store.insert(s);
    closeDatabase(); // flush WAL

    // Walk every file in the .alter dir and scan bytes for the probe strings.
    const probeDir = join(tmp, ".alter");
    const files = readdirSync(probeDir).map((f) => join(probeDir, f));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const buf = readFileSync(f);
      expect(buf.includes(Buffer.from(s.sessionToken, "utf8"))).toBe(false);
      expect(buf.includes(Buffer.from(s.authUrl, "utf8"))).toBe(false);
    }
  });

  it("get returns undefined for an unknown sessionToken", () => {
    const store = new AuthSessionStore(tmp, DB_KEY, HMAC_SECRET);
    expect(store.get("never-existed")).toBeUndefined();
  });

  it("get returns undefined when the lookup HMAC secret differs (can't enumerate)", () => {
    const writer = new AuthSessionStore(tmp, DB_KEY, HMAC_SECRET);
    const s = makePending();
    writer.insert(s);
    // A reader with a different HMAC secret derives a different lookup key and
    // can't even find the row, let alone decrypt it.
    const otherHmac = randomBytes(32);
    const reader = new AuthSessionStore(tmp, DB_KEY, otherHmac);
    expect(reader.get(s.sessionToken)).toBeUndefined();
  });

  it("get throws / returns undefined when the AEAD key differs (decryption fails)", () => {
    const writer = new AuthSessionStore(tmp, DB_KEY, HMAC_SECRET);
    const s = makePending();
    writer.insert(s);
    const otherDbKey = randomBytes(32);
    const reader = new AuthSessionStore(tmp, otherDbKey, HMAC_SECRET);
    // Reader finds the row (same HMAC secret) but can't decrypt — `get`
    // surfaces the GCM auth failure as a thrown error.
    expect(() => reader.get(s.sessionToken)).toThrow(/unable to authenticate data/);
  });

  it("setStatus and delete work via the HMAC lookup", () => {
    const store = new AuthSessionStore(tmp, DB_KEY, HMAC_SECRET);
    const s = makePending();
    store.insert(s);
    store.setStatus(s.sessionToken, "failed");
    expect(store.get(s.sessionToken)?.status).toBe("failed");
    store.delete(s.sessionToken);
    expect(store.get(s.sessionToken)).toBeUndefined();
  });

  it("listPending decrypts all in-flight rows and filters expired", () => {
    const store = new AuthSessionStore(tmp, DB_KEY, HMAC_SECRET);
    const fresh = makePending();
    const stale = makePending({
      sessionToken: "stale-tok",
      iatMs: Date.now() - AUTH_SESSION_DEFAULT_TTL_MS - 1,
    });
    store.insert(fresh);
    store.insert(stale);
    const pending = store.listPending(Date.now());
    expect(pending).toHaveLength(1);
    expect(pending[0]?.sessionToken).toBe(fresh.sessionToken);
  });

  it("rejects a non-32-byte AEAD key in the constructor", () => {
    expect(
      () => new AuthSessionStore(tmp, randomBytes(16), HMAC_SECRET),
    ).toThrow(/32 bytes/);
  });

  it("rejects a too-short HMAC secret in the constructor", () => {
    expect(
      () => new AuthSessionStore(tmp, DB_KEY, randomBytes(16)),
    ).toThrow(/32 bytes/);
  });
});
