import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { open, seal } from "../src/crypto/jwt-at-rest.js";

const KEY = randomBytes(32);
const AAD = { channelKind: "slack", channelUserId: "U123", rowId: "row-A" };

describe("AES-256-GCM at-rest with AAD", () => {
  it("round-trips with the same key + AAD", () => {
    const sealed = seal("hello world", KEY, AAD);
    expect(open(sealed, KEY, AAD)).toBe("hello world");
  });

  it("emits a fresh nonce per seal call", () => {
    const a = seal("payload", KEY, AAD);
    const b = seal("payload", KEY, AAD);
    expect(Buffer.compare(a.nonce, b.nonce)).not.toBe(0);
    expect(Buffer.compare(a.ciphertext, b.ciphertext)).not.toBe(0);
  });

  // Node's GCM decrypt failure surfaces as "Unsupported state or unable to
  // authenticate data" from openssl. Match on that substring so a future
  // refactor that returns a plaintext-on-failure (instead of throwing) trips
  // the test instead of silently passing. /auth/i also matches engine
  // variants like "auth tag" / "authenticate" / "decrypt authentication".
  const GCM_AUTH_FAILURE = /auth|decrypt|state/i;

  it("rejects open with the wrong key", () => {
    const sealed = seal("hello", KEY, AAD);
    const wrongKey = randomBytes(32);
    expect(() => open(sealed, wrongKey, AAD)).toThrow(GCM_AUTH_FAILURE);
  });

  it("rejects open with the wrong nonce", () => {
    const sealed = seal("hello", KEY, AAD);
    const tampered = { ...sealed, nonce: randomBytes(12) };
    expect(() => open(tampered, KEY, AAD)).toThrow(GCM_AUTH_FAILURE);
  });

  it("rejects open with mutated ciphertext", () => {
    const sealed = seal("hello", KEY, AAD);
    const buf = Buffer.from(sealed.ciphertext);
    buf[0] = (buf[0]! ^ 0xff) & 0xff;
    expect(() => open({ ...sealed, ciphertext: buf }, KEY, AAD)).toThrow(GCM_AUTH_FAILURE);
  });

  it("rejects open with mismatched channelKind in AAD", () => {
    const sealed = seal("hello", KEY, AAD);
    expect(() => open(sealed, KEY, { ...AAD, channelKind: "telegram" })).toThrow(
      GCM_AUTH_FAILURE,
    );
  });

  it("rejects open with mismatched channelUserId in AAD", () => {
    const sealed = seal("hello", KEY, AAD);
    expect(() => open(sealed, KEY, { ...AAD, channelUserId: "U999" })).toThrow(
      GCM_AUTH_FAILURE,
    );
  });

  it("ROW SWAP: sibling row's ciphertext fails GCM auth (closes plan C4)", () => {
    // Row A holds Alice's JWT; row B holds Bob's. An attacker with SQLite
    // write access copies Alice's (ciphertext, nonce) into Bob's row hoping
    // to impersonate. With (channel_kind, channel_user_id, row_id) bound
    // into the AAD, the open() call against Bob's identity fails.
    const aliceAad = { channelKind: "slack", channelUserId: "U_alice", rowId: "1000" };
    const bobAad = { channelKind: "slack", channelUserId: "U_bob", rowId: "2000" };
    const aliceSealed = seal("alice-jwt", KEY, aliceAad);
    expect(() => open(aliceSealed, KEY, bobAad)).toThrow(GCM_AUTH_FAILURE);
  });

  it("rejects keys that aren't 32 bytes", () => {
    expect(() => seal("x", randomBytes(16), AAD)).toThrow(/32 bytes/);
    const sealed = seal("x", KEY, AAD);
    expect(() => open(sealed, randomBytes(16), AAD)).toThrow(/32 bytes/);
  });
});
