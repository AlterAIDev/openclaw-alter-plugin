import { describe, expect, it } from "vitest";
import { decodeJwtPayloadUnsafe } from "../src/identity/jwt-decode.js";

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.fake-sig`;
}

describe("decodeJwtPayloadUnsafe", () => {
  it("extracts sub + exp from a well-formed JWT", () => {
    const tok = makeJwt({ sub: "user_123", exp: 9_999_999_999, iss: "alter" });
    const decoded = decodeJwtPayloadUnsafe(tok);
    expect(decoded.sub).toBe("user_123");
    expect(decoded.exp).toBe(9_999_999_999);
    expect(decoded.iss).toBe("alter");
  });

  it("rejects a token with no dot separator", () => {
    expect(() => decodeJwtPayloadUnsafe("not-a-jwt")).toThrow(/no dot|malformed/);
  });

  it("rejects a token with an empty payload segment", () => {
    expect(() => decodeJwtPayloadUnsafe("header..sig")).toThrow(/empty payload/);
  });

  it("rejects a token whose payload isn't valid JSON", () => {
    const garbage = `header.${b64url("not-json")}.sig`;
    expect(() => decodeJwtPayloadUnsafe(garbage)).toThrow(/payload JSON/);
  });

  it("rejects a payload missing sub", () => {
    const tok = makeJwt({ exp: 1234 });
    expect(() => decodeJwtPayloadUnsafe(tok)).toThrow(/sub/);
  });

  it("rejects a payload with non-string sub", () => {
    const tok = makeJwt({ sub: 42, exp: 1234 });
    expect(() => decodeJwtPayloadUnsafe(tok)).toThrow(/sub/);
  });

  it("rejects a payload with empty-string sub", () => {
    const tok = makeJwt({ sub: "", exp: 1234 });
    expect(() => decodeJwtPayloadUnsafe(tok)).toThrow(/sub/);
  });

  it("rejects a payload missing exp", () => {
    const tok = makeJwt({ sub: "u1" });
    expect(() => decodeJwtPayloadUnsafe(tok)).toThrow(/exp/);
  });

  it("rejects a payload with non-numeric exp", () => {
    const tok = makeJwt({ sub: "u1", exp: "soon" });
    expect(() => decodeJwtPayloadUnsafe(tok)).toThrow(/exp/);
  });

  it("rejects a token whose exp has already passed (with 60s skew tolerance)", () => {
    // exp two minutes in the past — well outside the 60s skew window.
    const past = Math.floor(Date.now() / 1000) - 120;
    const tok = makeJwt({ sub: "u1", exp: past });
    expect(() => decodeJwtPayloadUnsafe(tok)).toThrow(/expired/);
  });

  it("accepts a token whose exp is within the 60s skew tolerance", () => {
    // exp 30s in the past — still inside the skew window.
    const recentPast = Math.floor(Date.now() / 1000) - 30;
    const tok = makeJwt({ sub: "u1", exp: recentPast });
    const decoded = decodeJwtPayloadUnsafe(tok);
    expect(decoded.sub).toBe("u1");
  });

  it("allowExpired=true bypasses the local exp check", () => {
    const past = Math.floor(Date.now() / 1000) - 86_400;
    const tok = makeJwt({ sub: "u1", exp: past });
    const decoded = decodeJwtPayloadUnsafe(tok, { allowExpired: true });
    expect(decoded.exp).toBe(past);
  });

  it("rejects a 2-segment token (no signature segment)", () => {
    // Previously accepted any token with >=2 segments — a transport that
    // stripped the signature would silently succeed. Now strictly 3.
    expect(() => decodeJwtPayloadUnsafe("header.payload")).toThrow(/3.*segments/);
  });
});
