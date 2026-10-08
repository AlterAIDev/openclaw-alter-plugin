import { describe, expect, it } from "vitest";
import { AuthLoginRateLimit } from "../src/identity/login-rate-limit.js";

describe("AuthLoginRateLimit", () => {
  it("allows the first sign-in attempt", () => {
    const rl = new AuthLoginRateLimit({ capacity: 3 });
    expect(rl.check("slack", "U1", 1_000).allowed).toBe(true);
  });

  it("denies after burst is exhausted; sets retryAfter > 0", () => {
    const rl = new AuthLoginRateLimit({ capacity: 3, refillPerSecond: 0.01 });
    const now = 1_000;
    expect(rl.check("slack", "U1", now).allowed).toBe(true);
    expect(rl.check("slack", "U1", now).allowed).toBe(true);
    expect(rl.check("slack", "U1", now).allowed).toBe(true);
    const fourth = rl.check("slack", "U1", now);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("buckets are isolated per (channel, user)", () => {
    const rl = new AuthLoginRateLimit({ capacity: 1, refillPerSecond: 0.01 });
    const now = 1_000;
    expect(rl.check("slack", "U1", now).allowed).toBe(true);
    expect(rl.check("slack", "U1", now).allowed).toBe(false);
    // Different user — fresh bucket.
    expect(rl.check("slack", "U2", now).allowed).toBe(true);
    // Different channel — fresh bucket.
    expect(rl.check("telegram", "U1", now).allowed).toBe(true);
  });

  it("refills tokens at the configured rate", () => {
    const rl = new AuthLoginRateLimit({ capacity: 2, refillPerSecond: 1 });
    const now = 10_000;
    expect(rl.check("slack", "U1", now).allowed).toBe(true);
    expect(rl.check("slack", "U1", now).allowed).toBe(true);
    expect(rl.check("slack", "U1", now).allowed).toBe(false);
    // 1.5s later → 1.5 tokens → 1 allowed, next denied.
    expect(rl.check("slack", "U1", now + 1500).allowed).toBe(true);
    expect(rl.check("slack", "U1", now + 1500).allowed).toBe(false);
  });

  it("channel-user key avoids cross-channel-user collision", () => {
    // Verifies the null-byte separator in the bucket key — `("slack", "X0U")`
    // must not collide with `("slackX", "0U")` if the separator were absent.
    const rl = new AuthLoginRateLimit({ capacity: 1, refillPerSecond: 0.01 });
    const now = 1_000;
    expect(rl.check("slack", "X0U", now).allowed).toBe(true);
    expect(rl.check("slackX", "0U", now).allowed).toBe(true);
  });
});
