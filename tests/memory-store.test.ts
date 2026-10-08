import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/memory/store.js";
import { closeDatabase } from "../src/sqlite.js";

/**
 * Memory is partitioned by Alter's `memoryScope().userKey`. These tests pin the
 * isolation and — just as importantly — the refusals: every way a caller could
 * silently end up sharing a partition must throw rather than quietly write.
 */

let tmp: string;
let store: MemoryStore;

const ALICE = "alter:user:11111111-1111-1111-1111-111111111111";
const BOB = "alter:user:22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "alter-memory-"));
  store = new MemoryStore(tmp);
});

afterEach(() => {
  closeDatabase();
  rmSync(tmp, { recursive: true, force: true });
});

describe("memory is isolated per user", () => {
  it("never returns one user's memories to another", () => {
    store.add(ALICE, "Alice is drafting an email to Carol about merged PRs");
    expect(store.search(ALICE, undefined).map((r) => r.content)).toEqual([
      "Alice is drafting an email to Carol about merged PRs",
    ]);
    // The whole point.
    expect(store.search(BOB, undefined)).toEqual([]);
  });

  it("does not leak across users via a search query", () => {
    store.add(ALICE, "Alice's secret project codename is Bluebird");
    expect(store.search(BOB, "Bluebird")).toEqual([]);
    expect(store.search(BOB, "")).toEqual([]);
    expect(store.count(BOB)).toBe(0);
  });

  it("does not let one user delete another's memory, even knowing its id", () => {
    const row = store.add(ALICE, "Alice's note");
    expect(store.delete(BOB, row.id)).toBe(false);
    expect(store.search(ALICE, undefined)).toHaveLength(1);
    expect(store.delete(ALICE, row.id)).toBe(true);
  });

  it("forgetAll only forgets the caller's own", () => {
    store.add(ALICE, "a1");
    store.add(ALICE, "a2");
    store.add(BOB, "b1");
    expect(store.forgetAll(ALICE)).toBe(2);
    expect(store.count(ALICE)).toBe(0);
    expect(store.count(BOB)).toBe(1);
  });

  it("keeps each user's memories independent as both write", () => {
    store.add(ALICE, "alice likes terse replies");
    store.add(BOB, "bob likes long replies");
    expect(store.search(ALICE, undefined).map((r) => r.content)).toEqual(["alice likes terse replies"]);
    expect(store.search(BOB, undefined).map((r) => r.content)).toEqual(["bob likes long replies"]);
  });
});

describe("the store REFUSES anything that isn't an Alter-derived key", () => {
  it("refuses an empty key rather than creating a shared partition", () => {
    // This is the "defaults to default_user" bug Alter's guide names: an
    // unresolved caller must never quietly land in a bucket with everyone else.
    expect(() => store.add("", "x")).toThrow(/userKey is required/);
    expect(() => store.search("", undefined)).toThrow(/userKey is required/);
    expect(() => store.forgetAll("")).toThrow(/userKey is required/);
  });

  it("refuses the plugin's LOCAL app_user_id (idp:<sub>)", () => {
    // The subtle one. `idp:<sub>` is a valid-looking id we use everywhere else,
    // and keying memory on it would work — until an IdP migration changed the
    // sub and silently orphaned (or worse, re-assigned) the memories.
    expect(() => store.add("idp:auth0|abc", "x")).toThrow(/must be Alter's memoryScope/);
    expect(() => store.search("idp:auth0|abc", undefined)).toThrow(/must be Alter's memoryScope/);
  });

  it("refuses a raw uuid with no alter:user: prefix", () => {
    expect(() => store.add("11111111-1111-1111-1111-111111111111", "x")).toThrow(
      /must be Alter's memoryScope/,
    );
  });

  it("refuses an agent or app key used as a user key", () => {
    // memoryScope() also yields agentKey/appKey. Those are NOT per-user, so
    // partitioning on them would put every user of an agent in one bucket.
    expect(() => store.add("alter:agent:abc", "x")).toThrow(/must be Alter's memoryScope/);
    expect(() => store.add("alter:app:abc", "x")).toThrow(/must be Alter's memoryScope/);
  });
});

describe("search behaviour", () => {
  it("filters by substring, newest first", () => {
    const now = Date.now();
    store.add(ALICE, "prefers dark mode", now - 3000);
    store.add(ALICE, "prefers metric units", now - 2000);
    store.add(ALICE, "dislikes emoji", now - 1000);
    expect(store.search(ALICE, "prefers").map((r) => r.content)).toEqual([
      "prefers metric units",
      "prefers dark mode",
    ]);
  });

  it("returns newest-first with no query", () => {
    const now = Date.now();
    store.add(ALICE, "old", now - 5000);
    store.add(ALICE, "new", now);
    expect(store.search(ALICE, undefined).map((r) => r.content)).toEqual(["new", "old"]);
  });

  it("treats LIKE wildcards in the query as literal text", () => {
    // Without escaping, a query of "%" would dump every memory the user has —
    // harmless here (same user) but it would make `--query` behave bizarrely.
    store.add(ALICE, "hello world");
    store.add(ALICE, "100% cotton");
    expect(store.search(ALICE, "%").map((r) => r.content)).toEqual(["100% cotton"]);
    expect(store.search(ALICE, "_")).toEqual([]);
  });

  it("caps the limit so a recall can't dump unbounded rows into context", () => {
    for (let i = 0; i < 150; i++) store.add(ALICE, `note ${i}`);
    expect(store.search(ALICE, undefined, 9999)).toHaveLength(100);
    expect(store.search(ALICE, undefined, 5)).toHaveLength(5);
  });
});
