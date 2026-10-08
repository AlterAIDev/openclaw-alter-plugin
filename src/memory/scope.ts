import type { Agent } from "@alter-ai/alter-sdk";

/**
 * Resolves the memory partition key for a user, from Alter.
 *
 * ## Why this exists at all
 *
 * Memory is the one store in this plugin that must NOT be keyed on our local
 * `app_user_id`. Everywhere else, `idp:<sub>` is an internal convention and it
 * is fine. For memory it is wrong, for the reason Alter's own guidance gives:
 * key on `app_user_id`, "never on email or the raw IDP `sub`". A raw sub is an
 * IdP-scoped identifier — migrate IdP, or re-issue a subject, and it changes.
 * Memory keyed on it silently orphans; worse, a *reused* sub would silently
 * inherit someone else's memories.
 *
 * So the partition key comes from `agent.resolveIdentity()` →
 * `identity.memoryScope().userKey` = `alter:user:<canonical app_user_id>`,
 * which Alter derives server-side from the user's JWT. We never construct it.
 *
 * ## Why this is a security boundary, not a lookup
 *
 * The key is *plumbing*, never a tool parameter. The LLM says "remember X"; it
 * does not get to say whose memory to write. The rule is the same one the
 * approval lock follows: partition on verified identity, never on ambient
 * context (a session id) or model output (a user id in a tool call).
 *
 * `resolveIdentity` also fails closed for us: Alter rejects deprovisioned users
 * outright ("deprovisioned users are rejected, never returned"), so a
 * deprovisioned user cannot reach memory at all.
 */

export class MemoryScopeError extends Error {
  /**
   * The identity's status when Alter resolved it but it isn't active (e.g.
   * `"suspended"`). Unset for every other failure. Lets the tool tell "an
   * administrator must act" apart from "try again".
   */
  readonly userStatus?: string;

  constructor(message: string, options?: { cause?: unknown; userStatus?: string }) {
    super(message, options);
    this.name = "MemoryScopeError";
    if (options?.userStatus !== undefined) this.userStatus = options.userStatus;
  }
}

interface CacheEntry {
  userKey: string;
  expiresAtMs: number;
}

/**
 * How long a resolved userKey is reused before re-asking Alter.
 *
 * The trade: `resolveIdentity` is a network round-trip, and memory calls would
 * otherwise pay it every time. The cost of caching is that a user suspended at
 * Alter keeps reading THEIR OWN memories for up to this long. That is a
 * deliberately narrow exposure — it grants no provider access, no writes to
 * anyone else's data, and nothing another user can see — so a short window buys
 * a lot of latency for very little. Provider actions are unaffected: those
 * resolve grants per call and fail immediately.
 *
 * Keep this SHORT. It is not a session cache.
 */
const SCOPE_CACHE_TTL_MS = 5 * 60 * 1000;

export class MemoryScopeResolver {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(
    private readonly agent: Agent,
    private readonly ttlMs: number = SCOPE_CACHE_TTL_MS,
  ) {}

  /**
   * The caller's `alter:user:<app_user_id>` partition key.
   *
   * `cacheKey` is the plugin's local app_user_id — used ONLY as a cache bucket,
   * never as the partition key itself. `jwt` is the sealed user token; Alter
   * derives the real identity from it.
   *
   * Throws {@link MemoryScopeError} rather than returning a fallback. There is
   * no safe default here: a fallback key would either collide users together or
   * silently write to a partition nobody can read back.
   */
  async resolve(cacheKey: string, jwt: string, nowMs = Date.now()): Promise<string> {
    const hit = this.cache.get(cacheKey);
    if (hit && hit.expiresAtMs > nowMs) return hit.userKey;

    // Singleflight: several memory calls in one turn shouldn't each round-trip.
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;

    const fresh = this.fetch(jwt, nowMs)
      .then((userKey) => {
        this.cache.set(cacheKey, { userKey, expiresAtMs: nowMs + this.ttlMs });
        return userKey;
      })
      .finally(() => this.inFlight.delete(cacheKey));
    this.inFlight.set(cacheKey, fresh);
    return fresh;
  }

  private async fetch(jwt: string, _nowMs: number): Promise<string> {
    let identity;
    try {
      identity = await this.agent.resolveIdentity({ userToken: jwt });
    } catch (e) {
      // Includes the deprovisioned-user rejection. Never fall back to a
      // locally-derived key: that is precisely the "defaults to default_user"
      // failure Alter's guide calls out.
      throw new MemoryScopeError(
        `could not resolve identity for memory: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
    // Reading the resolved identity is itself a runtime boundary: `identity` is
    // a value the SDK handed back, and a version skew that changed its shape (a
    // missing memoryScope(), an absent userStatus) must fail CLOSED with our
    // friendly message — not throw a raw TypeError out of the tool, which
    // tools.ts re-raises as an unhandled error. Our own MemoryScopeError
    // refusals below are intentional and pass through unwrapped.
    try {
      // Defence in depth: the SDK says suspended users are rejected rather than
      // returned, but if that ever changes we must not partition memory for one.
      if (identity.userStatus !== null && identity.userStatus !== "active") {
        throw new MemoryScopeError(`identity is not active (status=${identity.userStatus})`, {
          userStatus: identity.userStatus,
        });
      }
      const scope = identity.memoryScope();
      const userKey = scope.userKey;
      if (!userKey) {
        // null userKey = a headless context (no end user). A memory call with no
        // end user has no owner, so there is nothing correct to do but refuse.
        throw new MemoryScopeError(
          "no end-user identity on this call — memory has no owner to key on",
        );
      }
      return userKey;
    } catch (e) {
      if (e instanceof MemoryScopeError) throw e;
      throw new MemoryScopeError(
        `unexpected identity shape from Alter: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
  }

  /** Drop a cached key — call when a user re-links or is unlinked. */
  invalidate(cacheKey: string): void {
    this.cache.delete(cacheKey);
  }
}
