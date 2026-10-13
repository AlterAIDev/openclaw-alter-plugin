import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { calendlyListScheduledEventsSpec } from "../src/tools/calendly-list-scheduled-events.js";
import { gcalCreateEventSpec } from "../src/tools/gcal-create-event.js";
import { gcalListEventsSpec } from "../src/tools/gcal-list-events.js";

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

// `format` alone doesn't bound a string: TypeBox accepts a date-time with a
// megabyte of fractional seconds, and a megabyte email. These real tool
// schemas carry an explicit maxLength for that.
describe("date-time and email tool params are length-bounded", () => {
  const longDate = `2026-10-13T09:00:00.${"1".repeat(1_000_000)}Z`;

  it.each([
    ["alter_gcal_create_event", () => gcalCreateEventSpec.parameters, { summary: "Sync", startIso: longDate, endIso: "2026-10-13T10:00:00Z" }],
    ["alter_gcal_create_event attendees", () => gcalCreateEventSpec.parameters, {
      summary: "Sync",
      startIso: "2026-10-13T09:00:00Z",
      endIso: "2026-10-13T10:00:00Z",
      attendees: [`${"a".repeat(1_000_000)}@example.com`],
    }],
    ["alter_gcal_list_events", () => gcalListEventsSpec.parameters, { timeMin: longDate }],
    ["alter_calendly_list_scheduled_events", () => calendlyListScheduledEventsSpec.parameters, {
      userUri: "https://api.calendly.com/users/u1",
      minStartTime: longDate,
    }],
  ])("%s rejects an oversized value", (_, schema, params) => {
    expect(Value.Check(schema(), params)).toBe(false);
  });

  it("still accepts ordinary values", () => {
    expect(Value.Check(gcalCreateEventSpec.parameters, {
      summary: "Sync",
      startIso: "2026-10-13T09:00:00.123456+05:30",
      endIso: "2026-10-13T10:00:00Z",
      attendees: ["alice@example.com"],
    })).toBe(true);
    expect(Value.Check(gcalListEventsSpec.parameters, { timeMin: "2026-10-13T09:00:00Z" })).toBe(true);
  });
});
