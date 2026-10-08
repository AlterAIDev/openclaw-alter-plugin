import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  timeMin: Type.Optional(Type.String({ format: "date-time" })),
  timeMax: Type.Optional(Type.String({ format: "date-time" })),
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
    if (params["timeMin"]) qp["timeMin"] = String(params["timeMin"]);
    if (params["timeMax"]) qp["timeMax"] = String(params["timeMax"]);
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
