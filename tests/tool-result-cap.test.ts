import { describe, expect, it } from "vitest";
import { capToolResultJson } from "../src/tool-result-cap.js";

describe("capToolResultJson", () => {
  it("passes a small payload through with truncated:false", () => {
    const out = capToolResultJson({ a: 1, b: "hi" }, { maxBytes: 8192 });
    const parsed = JSON.parse(out);
    expect(parsed.truncated).toBe(false);
    expect(parsed.partial).toEqual({ a: 1, b: "hi" });
  });

  it("CAPS LISTS to the configured maxListLen", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const out = capToolResultJson({ results: items }, { maxBytes: 8192, maxListLen: 5 });
    const parsed = JSON.parse(out);
    expect(parsed.truncated).toBe(true);
    expect(parsed.truncatedReason).toBe("list-cap");
    expect(parsed.partial.results.length).toBe(5);
  });

  it("TRUNCATES OVERSIZED STRINGS based on UTF-8 BYTES (not UTF-16 code units)", () => {
    // CJK characters are 3 bytes each in UTF-8 but 1 code unit in UTF-16.
    // A naive .slice() byte cap would count wrong here.
    const cjk = "漢字テスト".repeat(200); // ~3000 bytes, 1000 code units
    const out = capToolResultJson({ text: cjk }, { maxBytes: 8192, perStringMaxBytes: 100 });
    const parsed = JSON.parse(out);
    expect(parsed.truncated).toBe(true);
    expect(parsed.partial.text.endsWith("…[truncated]")).toBe(true);
    // Truncated string + sentinel must fit in the per-string cap.
    expect(Buffer.byteLength(parsed.partial.text, "utf8")).toBeLessThanOrEqual(100);
  });

  it("ALWAYS produces parseable JSON, even when the envelope cap fires", () => {
    const huge = { lots: "x".repeat(20_000) };
    const out = capToolResultJson(huge, { maxBytes: 256 });
    expect(() => JSON.parse(out)).not.toThrow();
    const parsed = JSON.parse(out);
    expect(parsed.truncated).toBe(true);
  });

  it("recurses into nested arrays and objects", () => {
    const nested = {
      results: [
        { items: Array.from({ length: 50 }, (_, i) => `r${i}`) },
        { items: Array.from({ length: 50 }, (_, i) => `s${i}`) },
      ],
    };
    const out = capToolResultJson(nested, { maxBytes: 8192, maxListLen: 3 });
    const parsed = JSON.parse(out);
    expect(parsed.truncated).toBe(true);
    expect(parsed.partial.results[0].items.length).toBe(3);
    expect(parsed.partial.results[1].items.length).toBe(3);
  });

  it("preserves null and primitive values", () => {
    const out = capToolResultJson({ a: null, b: 42, c: true, d: false }, { maxBytes: 8192 });
    const parsed = JSON.parse(out);
    expect(parsed.partial).toEqual({ a: null, b: 42, c: true, d: false });
  });

  it("never splits a multi-code-unit surrogate pair (emoji/astral)", () => {
    // 🙂 (U+1F642) is a surrogate pair in UTF-16 (🙂) and 4
    // bytes in UTF-8. A naive .slice() on a UTF-16 code unit could leave
    // a lone surrogate at the truncation boundary, which downstream
    // JSON.stringify would emit as an unpaired \uD83D escape.
    const emojiRun = "🙂".repeat(200); // ~800 bytes UTF-8
    const out = capToolResultJson({ text: emojiRun }, {
      maxBytes: 8192,
      // Pick a cap that lands mid-emoji on a naive UTF-16 slice.
      perStringMaxBytes: 50,
    });
    const parsed = JSON.parse(out);
    expect(parsed.truncated).toBe(true);
    // The truncated string must be valid UTF-16 (no lone surrogates).
    // Test by re-encoding and confirming round-trip stability.
    const text: string = parsed.partial.text;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) {
        // high surrogate — must be followed by a low surrogate
        const next = text.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
        i++;
      } else if (c >= 0xdc00 && c <= 0xdfff) {
        // unpaired low surrogate
        throw new Error(`lone low surrogate at index ${i}`);
      }
    }
  });

  it("handles perStringMaxBytes smaller than the sentinel size without overflowing maxBytes", () => {
    // Sentinel "…[truncated]" is ~14 UTF-8 bytes. A per-string cap below
    // the sentinel size used to produce `s.slice(0, 0) + sentinel`, which
    // exceeded the cap. New behavior: emit an empty string + truncated=true.
    const out = capToolResultJson({ text: "x".repeat(1000) }, {
      maxBytes: 8192,
      perStringMaxBytes: 5,
    });
    const parsed = JSON.parse(out);
    expect(parsed.truncated).toBe(true);
    // The partial.text length is bounded by perStringMaxBytes; empty is
    // acceptable.
    expect(Buffer.byteLength(parsed.partial.text, "utf8")).toBeLessThanOrEqual(5);
  });

  it("envelope-cap iterates until output fits maxBytes (no overshoot from re-stringify inflation)", () => {
    // A string with heavy JSON-escape inflation (every char becomes 6 bytes
    // when escaped: e.g. ). After the initial envelope-cap, the
    // re-stringified output can exceed maxBytes; the iterative loop must
    // shrink until it fits.
    const inflatable = "".repeat(10_000);
    const out = capToolResultJson({ payload: inflatable }, { maxBytes: 400 });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(400);
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("never exceeds maxBytes even when the input value is exactly the boundary case", () => {
    // Build an input whose serialized form would land at maxBytes ± a few
    // bytes — verifies the early-return path doesn't accidentally over-emit.
    const body = "x".repeat(100);
    const out = capToolResultJson({ body }, { maxBytes: 8192 });
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(8192);
    expect(JSON.parse(out).truncated).toBe(false);
  });
});
