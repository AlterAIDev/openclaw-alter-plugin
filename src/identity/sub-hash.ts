import { createHash } from "node:crypto";

/**
 * Stable, low-cardinality correlation token for log lines that need to refer
 * to a user without echoing identifying material.
 *
 * Earlier code logged `idp:${sub.slice(0, 8)}…` which is a low-entropy prefix
 * of the IdP `sub` claim — for IdPs whose subs are semantic (Clerk's
 * `user_<26 base32>`), the first 8 characters are a meaningful prefix. Log
 * shipping (Loki, Datadog, etc.) then carries partial subs to wherever logs
 * land.
 *
 * `hashIdpSub` collapses the sub through SHA-256 mixed with the
 * per-deployment `channelHashSalt`, then returns a 16-char hex prefix.
 * The salt makes the hash non-correlatable across deployments (no shared
 * rainbow-table target) and the 16 chars give enough collision resistance
 * to track a user across log lines within one deployment without echoing
 * any portion of the underlying sub.
 */
export function hashIdpSub(channelHashSalt: string, sub: string): string {
  return createHash("sha256")
    .update(channelHashSalt)
    .update(":idp-sub:")
    .update(sub)
    .digest("hex")
    .slice(0, 16);
}
