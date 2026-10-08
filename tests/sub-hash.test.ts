import { describe, expect, it } from "vitest";
import { hashIdpSub } from "../src/identity/sub-hash.js";

describe("hashIdpSub", () => {
  it("returns a 16-char hex string", () => {
    const out = hashIdpSub("salt-x".repeat(4), "user_2ZqXg…");
    expect(out).toMatch(/^[0-9a-f]{16}$/);
  });

  it("is deterministic for the same (salt, sub)", () => {
    const a = hashIdpSub("salt-x".repeat(4), "user_a");
    const b = hashIdpSub("salt-x".repeat(4), "user_a");
    expect(a).toBe(b);
  });

  it("different subs hash to different values", () => {
    const salt = "salt-x".repeat(4);
    expect(hashIdpSub(salt, "user_a")).not.toBe(hashIdpSub(salt, "user_b"));
  });

  it("different salts hash the same sub to different values (deployment-scoped)", () => {
    const a = hashIdpSub("salt-1".repeat(4), "user_a");
    const b = hashIdpSub("salt-2".repeat(4), "user_a");
    expect(a).not.toBe(b);
  });

  it("does not echo any 8-char prefix of the input sub", () => {
    const sub = "user_2ZqXgAbCdEfGhIjKlMnOpQrSt";
    const hash = hashIdpSub("salt-x".repeat(4), sub);
    // Defensive: the hash should not contain any 8-character window of the
    // sub. Anything shorter than 8 chars is likely a coincidental hex
    // collision (the hash is hex; the sub is base32-ish), and we accept
    // those.
    for (let i = 0; i + 8 <= sub.length; i++) {
      expect(hash).not.toContain(sub.slice(i, i + 8));
    }
  });
});
