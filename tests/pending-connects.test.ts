import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PendingConnectsStore } from "../src/grants/pending-connects.js";
import { closeDatabase } from "../src/sqlite.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "alter-pc-"));
});
afterEach(() => {
  closeDatabase();
  rmSync(tmp, { recursive: true, force: true });
});

function insert(store: PendingConnectsStore, csrfNonce: string, iatMs = Date.now()) {
  store.insert({
    csrfNonce,
    sessionId: "sess",
    appUserId: "idp:abc",
    provider: "google",
    iatMs,
    ttlMs: 10 * 60 * 1000,
  });
}

describe("PendingConnectsStore.consume — CSRF guard", () => {
  it("first consume returns the row, sets consumed=1", () => {
    const s = new PendingConnectsStore(tmp);
    insert(s, "nonce-A");
    const r = s.consume("nonce-A", Date.now());
    expect(r?.csrfNonce).toBe("nonce-A");
    expect(r?.provider).toBe("google");
  });

  it("second consume of same nonce returns undefined (replay refused)", () => {
    const s = new PendingConnectsStore(tmp);
    insert(s, "nonce-A");
    const first = s.consume("nonce-A", Date.now());
    expect(first).toBeDefined();
    const replay = s.consume("nonce-A", Date.now());
    expect(replay).toBeUndefined();
  });

  it("unknown nonce returns undefined", () => {
    const s = new PendingConnectsStore(tmp);
    expect(s.consume("never-inserted", Date.now())).toBeUndefined();
  });

  it("expired nonce returns undefined even if never consumed", () => {
    const s = new PendingConnectsStore(tmp);
    insert(s, "nonce-A", Date.now() - 60 * 60 * 1000); // 1h old, ttl 10m
    expect(s.consume("nonce-A", Date.now())).toBeUndefined();
  });

  it("two stores against the same dir share state (one consume blocks the other)", () => {
    // Mirrors the production case where the connect-routes handler and a CLI
    // both observe the same .alter/plugin.sqlite.
    const a = new PendingConnectsStore(tmp);
    const b = new PendingConnectsStore(tmp);
    insert(a, "nonce-shared");
    expect(a.consume("nonce-shared", Date.now())).toBeDefined();
    expect(b.consume("nonce-shared", Date.now())).toBeUndefined();
  });
});
