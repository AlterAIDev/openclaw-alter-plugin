/**
 * In-memory per-(channel, user) token bucket guarding `/alter login` and
 * `buildConnectUrl`'s implicit `startLogin` fallback.
 *
 * Without this, an attacker who knows or guesses a `(channelKind, channelUserId)`
 * pair can spam `App.createAuthSession` (and a row into our SQLite
 * `pending_auth_sessions` table) at LLM-tool-call rate.
 *
 * Sized for legitimate users: 5 attempts per (channel, user) per 15 minutes.
 * A real user re-trying a flaky sign-in burns 1-2 of these; a script firing in
 * a loop is denied after the burst.
 */
export interface LoginRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface AuthLoginRateLimitOptions {
  capacity?: number;
  /** Tokens per second. Default 5 / (15*60) ≈ 0.0056. */
  refillPerSecond?: number;
  /** Drop buckets idle longer than this. */
  idleEvictMs?: number;
}

const DEFAULT_CAPACITY = 5;
const DEFAULT_REFILL_PER_SECOND = DEFAULT_CAPACITY / (15 * 60);
const DEFAULT_IDLE_EVICT_MS = 60 * 60 * 1000;
const EVICT_SAMPLE_INTERVAL_MS = 60 * 1000;

export class AuthLoginRateLimit {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly idleEvictMs: number;
  private lastEvictMs = 0;

  constructor(opts: AuthLoginRateLimitOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.refillPerSecond = opts.refillPerSecond ?? DEFAULT_REFILL_PER_SECOND;
    this.idleEvictMs = opts.idleEvictMs ?? DEFAULT_IDLE_EVICT_MS;
  }

  /** Returns the bucket key for a (channelKind, channelUserId) pair. */
  private static key(channelKind: string, channelUserId: string): string {
    return `${channelKind}\x00${channelUserId}`;
  }

  check(
    channelKind: string,
    channelUserId: string,
    nowMs = Date.now(),
  ): LoginRateLimitDecision {
    // Sample-based eviction — full-map sweep would be O(n) on every login
    // attempt. Once per minute is enough to keep growth bounded without
    // burning CPU on every hit.
    if (nowMs - this.lastEvictMs > EVICT_SAMPLE_INTERVAL_MS) {
      this.evictIdle(nowMs);
      this.lastEvictMs = nowMs;
    }

    const key = AuthLoginRateLimit.key(channelKind, channelUserId);
    const existing = this.buckets.get(key);
    if (!existing) {
      this.buckets.set(key, { tokens: this.capacity - 1, lastRefillMs: nowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const elapsedSec = (nowMs - existing.lastRefillMs) / 1000;
    const refilled = Math.min(
      this.capacity,
      existing.tokens + elapsedSec * this.refillPerSecond,
    );
    if (refilled < 1) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((1 - refilled) / this.refillPerSecond),
      );
      existing.tokens = refilled;
      existing.lastRefillMs = nowMs;
      return { allowed: false, retryAfterSeconds };
    }
    existing.tokens = refilled - 1;
    existing.lastRefillMs = nowMs;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private evictIdle(nowMs: number): void {
    for (const [k, b] of this.buckets) {
      if (nowMs - b.lastRefillMs > this.idleEvictMs) {
        this.buckets.delete(k);
      }
    }
  }

  /** Exposed for tests. */
  size(): number {
    return this.buckets.size;
  }
}

export class LoginRateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(
      `Too many sign-in attempts. Try again in ~${retryAfterSeconds}s.`,
    );
    this.name = "LoginRateLimitedError";
  }
}
