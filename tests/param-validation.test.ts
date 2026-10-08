import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";

/**
 * Direct coverage for the TypeBox validation logic that gates every tool
 * call in `tools/base.ts`. We exercise the same primitives (Value.Check +
 * Value.Errors) against representative schemas to lock the contract.
 */

const NO_CRLF = "^[^\\r\\n]+$";
const GMAIL_SEND_PARAMS = Type.Object({
  to: Type.String({ minLength: 3, maxLength: 320, pattern: NO_CRLF }),
  subject: Type.String({ minLength: 1, maxLength: 256, pattern: NO_CRLF }),
  body: Type.String({ minLength: 1, maxLength: 64_000 }),
});

describe("tool param validation (TypeBox runtime gate)", () => {
  it("accepts a well-formed payload", () => {
    const p = { to: "a@b.test", subject: "hi", body: "hello" };
    expect(Value.Check(GMAIL_SEND_PARAMS, p)).toBe(true);
  });

  it("rejects a header-injection attempt via CRLF in subject", () => {
    const p = {
      to: "a@b.test",
      subject: "hi\r\nBcc: evil@attacker.test",
      body: "hello",
    };
    expect(Value.Check(GMAIL_SEND_PARAMS, p)).toBe(false);
    const errs = Value.Errors(GMAIL_SEND_PARAMS, p);
    expect(errs.length).toBeGreaterThan(0);
  });

  it("rejects an oversized field (>maxLength)", () => {
    const p = {
      to: "a@b.test",
      subject: "x".repeat(1024),
      body: "hi",
    };
    expect(Value.Check(GMAIL_SEND_PARAMS, p)).toBe(false);
  });

  it("rejects an empty required field", () => {
    const p = { to: "a@b.test", subject: "", body: "hi" };
    expect(Value.Check(GMAIL_SEND_PARAMS, p)).toBe(false);
  });

  it("rejects a missing required field", () => {
    const p = { to: "a@b.test", body: "hi" };
    expect(Value.Check(GMAIL_SEND_PARAMS, p)).toBe(false);
  });

  it("rejects a wrong-type field (number instead of string)", () => {
    const p = { to: 42, subject: "hi", body: "hello" };
    expect(Value.Check(GMAIL_SEND_PARAMS, p)).toBe(false);
  });

  it("first error carries an instancePath for the bad field", () => {
    const p = {
      to: "a@b.test",
      subject: "hi\nbad",
      body: "hello",
    };
    const errs = Value.Errors(GMAIL_SEND_PARAMS, p);
    const first = errs[0];
    expect(first).toBeDefined();
    // instancePath is JSON-pointer style, e.g. "/subject"
    expect(first?.instancePath).toMatch(/subject/);
  });
});
