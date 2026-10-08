const ENCODER = new TextEncoder();

// "…[truncated]" — counted in UTF-8 bytes (3 for the ellipsis + 11 ASCII).
const SENTINEL = "…[truncated]";
const SENTINEL_BYTES = ENCODER.encode(SENTINEL).length;

function utf8Bytes(s: string): number {
  return ENCODER.encode(s).length;
}

/** Returns true iff the JS string code unit at `i` is the high half of a surrogate pair. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** Snap `i` down to a code-point boundary so `s.slice(0, i)` never splits a surrogate pair. */
function snapToCodePointBoundary(s: string, i: number): number {
  if (i <= 0 || i >= s.length) return i;
  const prev = s.charCodeAt(i - 1);
  if (isHighSurrogate(prev)) return i - 1;
  return i;
}

function truncStringToBytes(s: string, maxBytes: number): { value: string; truncated: boolean } {
  if (utf8Bytes(s) <= maxBytes) return { value: s, truncated: false };
  // Reserve room for the sentinel inside `maxBytes`. If the caller asks for
  // a cap smaller than the sentinel itself, emit an empty payload with the
  // truncation flag set — never exceed `maxBytes`.
  const budget = maxBytes - SENTINEL_BYTES;
  if (budget <= 0) return { value: "", truncated: true };
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (utf8Bytes(s.slice(0, mid)) <= budget) lo = mid;
    else hi = mid - 1;
  }
  const safe = snapToCodePointBoundary(s, lo);
  return { value: s.slice(0, safe) + SENTINEL, truncated: true };
}

interface CapOpts {
  maxBytes: number;
  maxListLen?: number;
  perStringMaxBytes?: number;
}

function capValue(v: unknown, opts: Required<CapOpts>, info: { truncated: boolean; reason?: string }): unknown {
  if (v === null || typeof v !== "object") {
    if (typeof v === "string") {
      const r = truncStringToBytes(v, opts.perStringMaxBytes);
      if (r.truncated) {
        info.truncated = true;
        info.reason = info.reason ?? "string-cap";
      }
      return r.value;
    }
    return v;
  }
  if (Array.isArray(v)) {
    const cropped = v.slice(0, opts.maxListLen);
    const out = cropped.map((it) => capValue(it, opts, info));
    if (v.length > opts.maxListLen) {
      info.truncated = true;
      info.reason = info.reason ?? "list-cap";
    }
    return out;
  }
  const obj = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    out[k] = capValue(obj[k], opts, info);
  }
  return out;
}

export function capToolResultJson(value: unknown, opts: CapOpts): string {
  const filled: Required<CapOpts> = {
    maxBytes: opts.maxBytes,
    maxListLen: opts.maxListLen ?? 20,
    perStringMaxBytes: opts.perStringMaxBytes ?? 1024,
  };
  const info = { truncated: false, reason: undefined as string | undefined };
  const capped = capValue(value, filled, info);

  let serialized = JSON.stringify({
    truncated: info.truncated,
    truncatedReason: info.reason ?? null,
    partial: capped,
  });

  if (utf8Bytes(serialized) > filled.maxBytes) {
    // Envelope-cap fallback: keep the JSON parseable by re-serializing the
    // entire payload as a single JSON-encoded string inside `partial`.
    // Iterate to convergence: JSON.stringify adds quoting + escapes that
    // can re-inflate a string past the budget, so we may need a tighter
    // truncation. Cap at 4 retries to bound the work.
    const stringified =
      typeof capped === "string" ? capped : JSON.stringify(capped);
    let budget = Math.max(0, filled.maxBytes - 200);
    let attempts = 0;
    while (attempts < 4) {
      const r = truncStringToBytes(stringified, budget);
      serialized = JSON.stringify({
        truncated: true,
        truncatedReason: "envelope-cap",
        partial: r.value,
      });
      if (utf8Bytes(serialized) <= filled.maxBytes) break;
      // Shrink budget and retry — the overshoot is bounded by the
      // post-stringify quote/escape inflation, which is at most 2x in
      // pathological cases (every char escaped). Halving each time
      // converges fast.
      budget = Math.max(0, Math.floor(budget / 2));
      attempts++;
    }
  }
  return serialized;
}
