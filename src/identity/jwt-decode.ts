/**
 * JWT decoder — payload only, NO verification.
 *
 * Safe ONLY when the JWT has already been verified upstream. In this plugin
 * the JWT comes back from App.pollAuthSession where Alter has already validated
 * signature + iss + aud + exp + JWKS rotation server-side. We decode here only
 * to extract `sub` and `exp` for our local mapping + expiry-tracking; we do NOT
 * make trust decisions from the decoded payload that we wouldn't already make
 * from Alter's pre-verification.
 *
 * Replaces the `jose` dep that was needed when we hand-rolled JWKS verification.
 */

export interface DecodedJwtPayload {
  sub: string;
  exp: number;
  iat?: number;
  aud?: string | string[];
  iss?: string;
  [k: string]: unknown;
}

export function decodeJwtPayloadUnsafe(
  jwt: string,
  opts: { nowMs?: number; allowExpired?: boolean } = {},
): DecodedJwtPayload {
  const parts = jwt.split(".");
  // A real JWT has exactly 3 segments (header.payload.signature). Older code
  // accepted >=2 segments, which let `header.payload` (no signature) through
  // — a transport stripping the trailing segment would silently succeed.
  if (parts.length !== 3) {
    throw new Error("malformed JWT (expected 3 dot-separated segments)");
  }
  const payloadB64 = parts[1];
  if (!payloadB64) throw new Error("malformed JWT (empty payload segment)");
  let json: string;
  try {
    json = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch (e) {
    throw new Error(`malformed JWT payload base64: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(json) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`malformed JWT payload JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  const sub = parsed["sub"];
  const exp = parsed["exp"];
  if (typeof sub !== "string" || sub.length === 0) {
    throw new Error("JWT missing sub");
  }
  if (typeof exp !== "number" || !Number.isFinite(exp)) {
    throw new Error("JWT missing exp");
  }
  // Local exp sanity — Alter pre-verified `exp`, but a clock-skewed or
  // backdated token can still land here, and downstream code uses
  // `jwtExpiresAt` as a "freshness" gate without re-validating. Reject
  // already-expired tokens up front (with a 60s tolerance window for
  // clock skew, matching the state-hmac tolerance) unless the caller
  // explicitly opts into accepting expired payloads.
  if (!opts.allowExpired) {
    const nowMs = opts.nowMs ?? Date.now();
    if (exp * 1000 + 60_000 < nowMs) {
      throw new Error("JWT already expired");
    }
  }
  return { ...parsed, sub, exp } as DecodedJwtPayload;
}
