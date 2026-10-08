import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdentityStore } from "../src/identity/store.js";
import { closeDatabase } from "../src/sqlite.js";

let tmp: string;
const KEY = randomBytes(32);

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "alter-id-"));
});
afterEach(() => {
  closeDatabase();
  rmSync(tmp, { recursive: true, force: true });
});

describe("IdentityStore — collision policy (closes plan C3)", () => {
  it("inserts a new link and reads it back", () => {
    const s = new IdentityStore(tmp, KEY);
    const r = s.upsert({
      channelKind: "slack",
      channelUserId: "U1",
      appUserId: "idp:abc",
      idpSub: "abc",
      jwt: "header.payload.sig",
      jwtExpiresAt: Date.now() + 86_400_000,
    });
    expect(r.status).toBe("inserted");
    const read = s.get("slack", "U1");
    expect(read).toBeDefined();
    expect(read?.appUserId).toBe("idp:abc");
    expect(read?.jwt).toBe("header.payload.sig");
  });

  it("REFRESH: same sub re-link updates JWT but keeps app_user_id", () => {
    const s = new IdentityStore(tmp, KEY);
    s.upsert({
      channelKind: "slack",
      channelUserId: "U1",
      appUserId: "idp:abc",
      idpSub: "abc",
      jwt: "old-jwt",
      jwtExpiresAt: 1,
    });
    const r2 = s.upsert({
      channelKind: "slack",
      channelUserId: "U1",
      appUserId: "idp:abc",
      idpSub: "abc",
      jwt: "new-jwt",
      jwtExpiresAt: 999_999_999_999,
    });
    expect(r2.status).toBe("refreshed");
    const read = s.get("slack", "U1");
    expect(read?.jwt).toBe("new-jwt");
    expect(read?.jwtExpiresAt).toBe(999_999_999_999);
  });

  it("COLLISION: different sub for same channel user is REJECTED", () => {
    const s = new IdentityStore(tmp, KEY);
    s.upsert({
      channelKind: "slack",
      channelUserId: "U1",
      appUserId: "idp:alice",
      idpSub: "alice",
      jwt: "alice-jwt",
      jwtExpiresAt: Date.now() + 86_400_000,
    });
    const r = s.upsert({
      channelKind: "slack",
      channelUserId: "U1",
      appUserId: "idp:bob",
      idpSub: "bob",
      jwt: "bob-jwt",
      jwtExpiresAt: Date.now() + 86_400_000,
    });
    expect(r.status).toBe("rejected_collision");
    expect(r.existingAppUserId).toBe("idp:alice");
    // Verify the original row is unchanged
    const read = s.get("slack", "U1");
    expect(read?.appUserId).toBe("idp:alice");
    expect(read?.jwt).toBe("alice-jwt");
  });

  it("ON CONFLICT semantics: sequential same-sub upserts insert then refresh (BEGIN IMMEDIATE serialized)", () => {
    // SQLite better-sqlite3 / node:sqlite are synchronous in-process, so
    // a real concurrent race can't be exercised from this thread. What
    // this DOES verify is the contract: the same (channel, channel_user_id)
    // hit twice with the same idpSub produces (inserted, refreshed) and
    // the latest JWT is readable through the canonical-row AAD — i.e.
    // the post-INSERT SELECT path and the re-seal-under-canonical-rowId
    // path both work. This is the contract a real concurrent race would
    // depend on; the cross-process race itself is enforced by the
    // BEGIN IMMEDIATE wrapping inside upsert() and SQLite's serialization,
    // which we cannot exercise from a single Node thread.
    const s1 = new IdentityStore(tmp, KEY);
    const s2 = new IdentityStore(tmp, KEY);
    const r1 = s1.upsert({
      channelKind: "slack",
      channelUserId: "U_race",
      appUserId: "idp:abc",
      idpSub: "abc",
      jwt: "jwt-1",
      jwtExpiresAt: Date.now() + 1000,
    });
    const r2 = s2.upsert({
      channelKind: "slack",
      channelUserId: "U_race",
      appUserId: "idp:abc",
      idpSub: "abc",
      jwt: "jwt-2",
      jwtExpiresAt: Date.now() + 2000,
    });
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual(["inserted", "refreshed"]);
    // The refreshed JWT must be readable (re-sealed against canonical AAD).
    const read = s1.get("slack", "U_race");
    expect(read?.jwt).toBe("jwt-2");
  });

  it("upsert is wrapped in a transaction (failed seal rolls back to clean state)", () => {
    // Defense-in-depth assertion: if any step inside upsert() throws, the
    // partial work must roll back so the store stays consistent. Force a
    // failure by passing a wrong-length key to a fresh store, then verify
    // a subsequent valid call inserts cleanly.
    const badKey = Buffer.alloc(16); // wrong length → seal() throws
    const bad = new IdentityStore(tmp, badKey);
    expect(() =>
      bad.upsert({
        channelKind: "slack",
        channelUserId: "U_rollback",
        appUserId: "idp:abc",
        idpSub: "abc",
        jwt: "jwt-1",
        jwtExpiresAt: Date.now() + 1000,
      }),
    ).toThrow();
    // After the throw, a good store should not see a half-written row.
    const good = new IdentityStore(tmp, KEY);
    expect(good.get("slack", "U_rollback")).toBeUndefined();
    // And a fresh upsert succeeds (no leftover lock).
    const r = good.upsert({
      channelKind: "slack",
      channelUserId: "U_rollback",
      appUserId: "idp:abc",
      idpSub: "abc",
      jwt: "jwt-fresh",
      jwtExpiresAt: Date.now() + 1000,
    });
    expect(r.status).toBe("inserted");
  });

  it("unlink removes the row", () => {
    const s = new IdentityStore(tmp, KEY);
    s.upsert({
      channelKind: "slack",
      channelUserId: "U1",
      appUserId: "idp:abc",
      idpSub: "abc",
      jwt: "j",
      jwtExpiresAt: 1,
    });
    expect(s.unlink("slack", "U1")).toBe(true);
    expect(s.get("slack", "U1")).toBeUndefined();
    expect(s.unlink("slack", "U1")).toBe(false);
  });
});
