import { describe, expect, it } from "vitest";
import { ConnectCallbackRateLimit } from "../src/grants/connect-rate-limit.js";

describe("ConnectCallbackRateLimit", () => {
  it("allows the first request and consumes a token", () => {
    const rl = new ConnectCallbackRateLimit({ capacity: 3, refillPerSecond: 1 });
    expect(rl.check("1.2.3.4", 1000).allowed).toBe(true);
  });

  it("rejects after the bucket is drained, sets retryAfter > 0", () => {
    const rl = new ConnectCallbackRateLimit({ capacity: 3, refillPerSecond: 1 });
    const now = 1000;
    expect(rl.check("1.2.3.4", now).allowed).toBe(true);
    expect(rl.check("1.2.3.4", now).allowed).toBe(true);
    expect(rl.check("1.2.3.4", now).allowed).toBe(true);
    const fourth = rl.check("1.2.3.4", now);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("refills tokens over time at the configured rate", () => {
    const rl = new ConnectCallbackRateLimit({ capacity: 2, refillPerSecond: 1 });
    const now = 10_000;
    expect(rl.check("ip-A", now).allowed).toBe(true);
    expect(rl.check("ip-A", now).allowed).toBe(true);
    expect(rl.check("ip-A", now).allowed).toBe(false);
    // 1.5s later we have 1.5 tokens → allows one, then 0.5 → next is denied.
    expect(rl.check("ip-A", now + 1500).allowed).toBe(true);
    expect(rl.check("ip-A", now + 1500).allowed).toBe(false);
  });

  it("buckets are isolated per IP", () => {
    const rl = new ConnectCallbackRateLimit({ capacity: 1, refillPerSecond: 1 });
    const now = 1000;
    expect(rl.check("ip-A", now).allowed).toBe(true);
    expect(rl.check("ip-A", now).allowed).toBe(false);
    // ip-B has its own fresh bucket.
    expect(rl.check("ip-B", now).allowed).toBe(true);
  });

  it("evicts idle buckets so the map doesn't grow unbounded", () => {
    const rl = new ConnectCallbackRateLimit({
      capacity: 1,
      refillPerSecond: 1,
      idleEvictMs: 5_000,
      // Force eviction on every check so the test is deterministic.
      evictSampleIntervalMs: 0,
    });
    rl.check("ip-A", 1_000);
    rl.check("ip-B", 2_000);
    expect(rl.size()).toBe(2);
    // After idleEvictMs since last check, both should be gone before the new
    // hit is recorded.
    rl.check("ip-C", 10_000);
    expect(rl.size()).toBe(1);
  });
});
