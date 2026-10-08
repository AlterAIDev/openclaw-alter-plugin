import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 256 }),
  description: Type.Optional(Type.String({ maxLength: 8192 })),
  startIso: Type.String({ format: "date-time" }),
  endIso: Type.String({ format: "date-time" }),
  attendees: Type.Optional(Type.Array(Type.String({ format: "email" }), { maxItems: 50 })),
});

export const gcalCreateEventSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_gcal_create_event",
  description: "Create an event on the user's primary Google Calendar. HITL-approved.",
  parameters: PARAMS,
  provider: "google",
  hitl: true,
  async toProxyArgs(params) {
    const body: Record<string, unknown> = {
      summary: String(params["summary"]),
      start: { dateTime: String(params["startIso"]) },
      end: { dateTime: String(params["endIso"]) },
    };
    if (typeof params["description"] === "string") body["description"] = params["description"];
    const attendees = params["attendees"];
    if (Array.isArray(attendees)) {
      body["attendees"] = attendees.map((email) => ({ email: String(email) }));
    }
    return {
      method: "POST",
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      jsonBody: body,
      headers: { "Content-Type": "application/json" },
    };
  },
  formatResult(result: ApprovalResult): unknown {
    try {
      return result.bodyJson();
    } catch {
      return { raw: result.bodyText() };
    }
  },
};
