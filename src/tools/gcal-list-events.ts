import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  timeMin: Type.Optional(Type.String({ format: "date-time", maxLength: 64 })),
  timeMax: Type.Optional(Type.String({ format: "date-time", maxLength: 64 })),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const gcalListEventsSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_gcal_list_events",
  description: "List the user's primary Google Calendar events in a time range.",
  parameters: PARAMS,
  provider: "google",
  async toProxyArgs(params) {
    const qp: Record<string, unknown> = {
      maxResults: Number(params["maxResults"] ?? 10),
      singleEvents: true,
      orderBy: "startTime",
    };
    const { timeMin, timeMax } = params;
    if (typeof timeMin === "string" && timeMin) qp["timeMin"] = timeMin;
    if (typeof timeMax === "string" && timeMax) qp["timeMax"] = timeMax;
    return {
      method: "GET",
      url: "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      queryParams: qp,
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
