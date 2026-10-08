import { hkdfSync } from "node:crypto";

/**
 * Domain-separated subkey derivation from the operator's master DB key.
 *
 * The master key (`OPENCLAW_ALTER_DB_KEY`) is a single 32-byte hex secret.
 * We never use it directly — every consumer asks for a labelled subkey via
 * HKDF-Expand-then-Extract so that a key recovered from one context (e.g. an
 * AEAD ciphertext + AAD known-plaintext attack) cannot be used to forge a
 * different context's ciphertexts.
 *
 * Labels are stable strings; do not rename them — rotating a label would
 * silently invalidate every existing AEAD blob sealed under the old subkey.
 * If you ever need to add a new context, append a NEW label.
 */
export const KEY_LABELS = {
  /** AES-256-GCM key for IdentityStore JWT seals. */
  IDENTITY_JWT_SEAL: "alter-plugin/v1/identity-jwt-seal",
  /** AES-256-GCM key for AuthSessionStore session-token + auth-url seals. */
  AUTH_SESSION_SEAL: "alter-plugin/v1/auth-session-seal",
  /** HMAC-SHA256 key for AuthSessionStore row-lookup hashes. */
  AUTH_SESSION_LOOKUP_HMAC: "alter-plugin/v1/auth-session-lookup-hmac",
} as const;

export type KeyLabel = (typeof KEY_LABELS)[keyof typeof KEY_LABELS];

const SALT = Buffer.from("alter-plugin-hkdf-salt-v1", "utf8");

/**
 * Derive a 32-byte subkey from `master` using HKDF-SHA-256 with the given
 * label as the info parameter. The salt is a fixed deployment-agnostic
 * string — domain separation is carried by `label`.
 */
export function deriveSubkey(master: Buffer, label: KeyLabel): Buffer {
  if (master.length < 32) {
    throw new Error("deriveSubkey: master must be >=32 bytes");
  }
  const info = Buffer.from(label, "utf8");
  const out = hkdfSync("sha256", master, SALT, info, 32);
  return Buffer.from(out);
}
