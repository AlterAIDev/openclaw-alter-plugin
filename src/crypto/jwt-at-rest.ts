import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface AeadAad {
  channelKind: string;
  channelUserId: string;
  rowId: string;
}

function aadBuffer(aad: AeadAad): Buffer {
  return Buffer.from(
    JSON.stringify({ k: aad.channelKind, u: aad.channelUserId, r: aad.rowId }),
    "utf8",
  );
}

export interface SealedPayload {
  ciphertext: Buffer;
  nonce: Buffer;
}

export function seal(plaintext: string, key: Buffer, aad: AeadAad): SealedPayload {
  if (key.length !== 32) {
    throw new Error("seal: key must be exactly 32 bytes");
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGO, key, nonce);
  cipher.setAAD(aadBuffer(aad));
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    throw new Error("seal: unexpected GCM tag length");
  }
  return { ciphertext: Buffer.concat([enc, tag]), nonce };
}

export function open(sealed: SealedPayload, key: Buffer, aad: AeadAad): string {
  if (key.length !== 32) {
    throw new Error("open: key must be exactly 32 bytes");
  }
  if (sealed.nonce.length !== NONCE_BYTES) {
    throw new Error("open: nonce must be 12 bytes");
  }
  if (sealed.ciphertext.length < TAG_BYTES) {
    throw new Error("open: ciphertext too short");
  }
  const tagOffset = sealed.ciphertext.length - TAG_BYTES;
  const enc = sealed.ciphertext.subarray(0, tagOffset);
  const tag = sealed.ciphertext.subarray(tagOffset);
  const decipher = createDecipheriv(ALGO, key, sealed.nonce);
  decipher.setAAD(aadBuffer(aad));
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf8");
}
