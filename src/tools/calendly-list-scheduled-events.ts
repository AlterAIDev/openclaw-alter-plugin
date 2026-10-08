import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  userUri: Type.String({
    minLength: 1,
    maxLength: 256,
    description:
      "Calendly user URI, e.g. `https://api.calendly.com/users/<uuid>`. Get this from `alter_calendly_get_current_user`.",
  }),
  minStartTime: Type.Optional(Type.String({ format: "date-time" })),
  maxStartTime: Type.Optional(Type.String({ format: "date-time" })),
  status: Type.Optional(
    Type.Union([Type.Literal("active"), Type.Literal("canceled")]),
  ),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const calendlyListScheduledEventsSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_calendly_list_scheduled_events",
  description:
    "List the user's Calendly scheduled events (bookings on their calendar) within an optional time " +
    "range. Includes invitee count, event URI, and join URLs.",
  parameters: PARAMS,
  provider: "calendly",
  async toProxyArgs(params) {
    const qp: Record<string, unknown> = {
      user: String(params["userUri"]),
      count: Number(params["count"] ?? 20),
      sort: "start_time:asc",
    };
    if (params["minStartTime"]) qp["min_start_time"] = String(params["minStartTime"]);
    if (params["maxStartTime"]) qp["max_start_time"] = String(params["maxStartTime"]);
    if (params["status"]) qp["status"] = String(params["status"]);
    return {
      method: "GET",
      url: "https://api.calendly.com/scheduled_events",
      queryParams: qp,
      headers: { Accept: "application/json" },
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
