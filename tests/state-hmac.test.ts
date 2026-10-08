import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  STATE_TYP,
  StateHmac,
  newCsrfNonce,
  type ConnectStatePayload,
  type LinkStatePayload,
} from "../src/grants/state-hmac.js";

const SECRET = randomBytes(32);

function makeLinkPayload(overrides: Partial<LinkStatePayload> = {}): LinkStatePayload {
  return {
    typ: STATE_TYP.LINK,
    csrfNonce: newCsrfNonce(),
    sessionId: "sess_1",
    channelKind: "slack",
    channelUserId: "U123",
    iatMs: Date.now(),
    ttlMs: 600_000,
    ...overrides,
  };
}

function makeConnectPayload(): ConnectStatePayload {
  return {
    typ: STATE_TYP.CONNECT,
    csrfNonce: newCsrfNonce(),
    sessionId: "sess_1",
    channelKind: "slack",
    channelUserId: "U123",
    iatMs: Date.now(),
    ttlMs: 600_000,
    appUserId: "idp:abc",
    provider: "google",
  };
}

describe("StateHmac", () => {
  it("rejects too-short secret", () => {
    expect(() => new StateHmac(randomBytes(16))).toThrow(/32 bytes/);
  });

  it("round-trips a link payload", () => {
    const sh = new StateHmac(SECRET);
    const p = makeLinkPayload();
    const tok = sh.sign(p);
    expect(sh.verify<LinkStatePayload>(tok, Date.now(), STATE_TYP.LINK)).toEqual(p);
  });

  it("round-trips a connect payload", () => {
    const sh = new StateHmac(SECRET);
    const p = makeConnectPayload();
    const tok = sh.sign(p);
    expect(sh.verify<ConnectStatePayload>(tok, Date.now(), STATE_TYP.CONNECT)).toEqual(p);
  });

  it("rejects a token of one type presented to a handler expecting another", () => {
    // A link-typed token must not be accepted by a connect-typed verifier,
    // even though the HMAC is valid. Without the typ check, downstream code
    // would access `.appUserId`/`.provider` on a value that doesn't have
    // them and produce confusing errors.
    const sh = new StateHmac(SECRET);
    const linkTok = sh.sign(makeLinkPayload());
    expect(() =>
      sh.verify<ConnectStatePayload>(linkTok, Date.now(), STATE_TYP.CONNECT),
    ).toThrow(/typ mismatch/);

    const connectTok = sh.sign(makeConnectPayload());
    expect(() =>
      sh.verify<LinkStatePayload>(connectTok, Date.now(), STATE_TYP.LINK),
    ).toThrow(/typ mismatch/);
  });

  it("rejects mutated body (HMAC mismatch)", () => {
    const sh = new StateHmac(SECRET);
    const tok = sh.sign(makeLinkPayload());
    const dot = tok.indexOf(".");
    const body = tok.slice(0, dot);
    const sig = tok.slice(dot + 1);
    // flip a char inside the body — anything legal-looking will do
    const mutated = body.slice(0, body.length - 1) + (body.endsWith("A") ? "B" : "A");
    expect(() =>
      sh.verify(`${mutated}.${sig}`, Date.now(), STATE_TYP.LINK),
    ).toThrow(/signature/);
  });

  it("rejects mutated signature", () => {
    const sh = new StateHmac(SECRET);
    const tok = sh.sign(makeLinkPayload());
    const tampered = tok.slice(0, -1) + (tok.endsWith("A") ? "B" : "A");
    expect(() => sh.verify(tampered, Date.now(), STATE_TYP.LINK)).toThrow(/signature/);
  });

  it("rejects an expired token", () => {
    const sh = new StateHmac(SECRET);
    const iat = Date.now() - 60 * 60_000;
    const tok = sh.sign(makeLinkPayload({ iatMs: iat, ttlMs: 60_000 }));
    expect(() => sh.verify(tok, Date.now(), STATE_TYP.LINK)).toThrow(/expired/);
  });

  it("rejects a token issued in the future (clock skew >60s)", () => {
    const sh = new StateHmac(SECRET);
    const tok = sh.sign(makeLinkPayload({ iatMs: Date.now() + 5 * 60_000 }));
    expect(() => sh.verify(tok, Date.now(), STATE_TYP.LINK)).toThrow(/future/);
  });

  it("rejects malformed token (no dot separator)", () => {
    const sh = new StateHmac(SECRET);
    expect(() => sh.verify("not-a-token", Date.now(), STATE_TYP.LINK)).toThrow(/malformed/);
  });

  it("rejects token signed with a different secret", () => {
    const sh1 = new StateHmac(SECRET);
    const sh2 = new StateHmac(randomBytes(32));
    const tok = sh1.sign(makeLinkPayload());
    expect(() => sh2.verify(tok, Date.now(), STATE_TYP.LINK)).toThrow(/signature/);
  });
});

describe("newCsrfNonce", () => {
  it("returns a 32-character base64url string", () => {
    const n = newCsrfNonce();
    expect(n).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("produces distinct values", () => {
    const set = new Set(Array.from({ length: 100 }, () => newCsrfNonce()));
    expect(set.size).toBe(100);
  });
});
