import { describe, expect, it } from "vitest";
import {
  PROVIDER_IDS,
  matchProviderId,
  providerDisplayName,
} from "../src/tools/providers.js";

describe("matchProviderId", () => {
  it("matches a canonical id exactly", () => {
    expect(matchProviderId("twitter")).toBe("twitter");
    expect(matchProviderId("linkedin")).toBe("linkedin");
  });

  it("is case-insensitive and strips punctuation", () => {
    expect(matchProviderId("LinkedIn")).toBe("linkedin");
    expect(matchProviderId("linked-in")).toBe("linkedin");
    expect(matchProviderId("Linked In")).toBe("linkedin");
  });

  it("resolves the X alias to the canonical twitter id", () => {
    expect(matchProviderId("x")).toBe("twitter");
    expect(matchProviderId("X")).toBe("twitter");
    expect(matchProviderId("x.com")).toBe("twitter");
  });

  it("returns null for unknown inputs", () => {
    expect(matchProviderId("mastodon")).toBeNull();
    expect(matchProviderId("")).toBeNull();
    expect(matchProviderId("!!!")).toBeNull();
  });

  it("twitter is in PROVIDER_IDS and renders as 'X (Twitter)'", () => {
    expect(PROVIDER_IDS).toContain("twitter");
    expect(providerDisplayName("twitter")).toBe("X (Twitter)");
  });
});
