import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Payload-type discriminator. `typ` lives in every signed token and is
 * verified at decode time so a token of one type cannot be presented to a
 * handler expecting another. Without this, a `link` payload with valid HMAC
 * could pass `verify<ConnectStatePayload>` and downstream code would access
 * fields that don't exist on the value, falling into generic catch handlers
 * and emitting confusing errors.
 *
 * Add new values here when introducing a new signed-token shape.
 */
export const STATE_TYP = {
  CONNECT: "connect",
  LINK: "link",
} as const;

export type StateTyp = (typeof STATE_TYP)[keyof typeof STATE_TYP];

interface TimedPayload {
  iatMs: number;
  ttlMs: number;
  typ: StateTyp;
}

export interface ConnectStatePayload extends TimedPayload {
  typ: typeof STATE_TYP.CONNECT;
  csrfNonce: string;
  sessionId: string;
  channelKind: string;
  channelUserId: string;
  appUserId: string;
  provider: string;
}

export interface LinkStatePayload extends TimedPayload {
  typ: typeof STATE_TYP.LINK;
  csrfNonce: string;
  sessionId: string;
  channelKind: string;
  channelUserId: string;
}

export class StateHmac {
  constructor(private readonly secret: Buffer) {
    if (secret.length < 32) throw new Error("StateHmac: secret must be >=32 bytes");
  }

  sign<P extends TimedPayload>(payload: P): string {
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    const sig = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${sig}`;
  }

  /**
   * Verify a state token and assert its `typ` matches the expected
   * discriminator. Callers MUST pass an explicit `expectedTyp` — never
   * call `verify` without one, otherwise a `link` payload could pass a
   * `verify<ConnectStatePayload>` site.
   */
  verify<P extends TimedPayload>(
    token: string,
    nowMs: number,
    expectedTyp: P["typ"],
  ): P {
    const dot = token.indexOf(".");
    if (dot < 0) throw new Error("malformed state token");
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);

    const expected = createHmac("sha256", this.secret).update(body).digest("base64url");
    const a = Buffer.from(sig, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error("state signature mismatch");
    }

    let parsed: P;
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as P;
    } catch {
      throw new Error("state body not parseable");
    }

    if (typeof parsed.iatMs !== "number" || typeof parsed.ttlMs !== "number") {
      throw new Error("state missing iatMs/ttlMs");
    }
    if (parsed.typ !== expectedTyp) {
      // Reject before any field access on parsed — a cross-typ token has
      // valid HMAC but wrong shape, and we don't want downstream `.provider`
      // or `.appUserId` lookups to silently return undefined.
      throw new Error(`state typ mismatch (expected ${expectedTyp})`);
    }
    if (nowMs > parsed.iatMs + parsed.ttlMs) {
      throw new Error("state expired");
    }
    if (nowMs + 60_000 < parsed.iatMs) {
      throw new Error("state issued in the future");
    }
    return parsed;
  }
}

export function newCsrfNonce(): string {
  return randomBytes(24).toString("base64url");
}
