/**
 * In-memory per-IP token bucket for /alter/connect/cb.
 *
 * The callback is internet-reachable by design (it's the OAuth redirect URI
 * Alter forwards back to). HMAC verification + the pending-row consume guard
 * make individual replays harmless, but an unauthenticated attacker can still
 * waste server work — every hit runs HMAC verify, SQLite consume, and (on
 * successful state-match) `listGrants` against Alter. We bound the worst case
 * with a per-IP token bucket sized for legitimate users:
 *
 *   default 10 tokens per IP, refilling at 1 token / second.
 *
 * Real OAuth flows hit the callback exactly once per connect; the bucket
 * absorbs a few legitimate retries (refresh, back-button) without
 * inconveniencing real users. Bucket state is per-process and resets on
 * restart — gateway HA would need a shared store, but that's overkill for
 * the current single-process plugin runtime.
 */
export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export interface ConnectRateLimitOptions {
  capacity?: number;
  refillPerSecond?: number;
  /**
   * Drop buckets that haven't been touched for this long. Keeps the Map
   * from growing unbounded — IPs we haven't seen in a while are forgotten.
   */
  idleEvictMs?: number;
  /**
   * Minimum interval between eviction sweeps. The sweep is O(n); running
   * it on every request was a hot-path footgun. Defaults to 60s, which is
   * fine for production. Tests pass `0` to force per-call eviction so
   * timing-based assertions are deterministic.
   */
  evictSampleIntervalMs?: number;
}

const DEFAULT_EVICT_SAMPLE_INTERVAL_MS = 60 * 1000;

export class ConnectCallbackRateLimit {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;
  private readonly idleEvictMs: number;
  private readonly evictSampleIntervalMs: number;
  private lastEvictMs = 0;

  constructor(opts: ConnectRateLimitOptions = {}) {
    this.capacity = opts.capacity ?? 10;
    this.refillPerSecond = opts.refillPerSecond ?? 1;
    this.idleEvictMs = opts.idleEvictMs ?? 10 * 60 * 1000;
    this.evictSampleIntervalMs =
      opts.evictSampleIntervalMs ?? DEFAULT_EVICT_SAMPLE_INTERVAL_MS;
  }

  check(ip: string, nowMs = Date.now()): RateLimitDecision {
    // Sample-based eviction — sweeping the whole Map on every request was
    // O(n) on the hot path. Running it at the configured interval keeps
    // memory bounded without measurable per-request cost.
    if (nowMs - this.lastEvictMs >= this.evictSampleIntervalMs) {
      this.evictIdle(nowMs);
      this.lastEvictMs = nowMs;
    }
    const existing = this.buckets.get(ip);
    if (!existing) {
      this.buckets.set(ip, { tokens: this.capacity - 1, lastRefillMs: nowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const elapsedSec = (nowMs - existing.lastRefillMs) / 1000;
    const refilled = Math.min(
      this.capacity,
      existing.tokens + elapsedSec * this.refillPerSecond,
    );
    if (refilled < 1) {
      const retryAfterSeconds = Math.max(1, Math.ceil((1 - refilled) / this.refillPerSecond));
      existing.tokens = refilled;
      existing.lastRefillMs = nowMs;
      return { allowed: false, retryAfterSeconds };
    }
    existing.tokens = refilled - 1;
    existing.lastRefillMs = nowMs;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private evictIdle(nowMs: number): void {
    for (const [ip, bucket] of this.buckets) {
      if (nowMs - bucket.lastRefillMs > this.idleEvictMs) {
        this.buckets.delete(ip);
      }
    }
  }

  /** Exposed for tests; returns number of buckets currently held. */
  size(): number {
    return this.buckets.size;
  }
}
