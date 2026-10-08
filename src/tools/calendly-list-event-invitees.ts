import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  eventUuid: Type.String({
    minLength: 1,
    maxLength: 64,
    description:
      "UUID portion of a scheduled event URI (the last path segment of " +
      "`https://api.calendly.com/scheduled_events/<uuid>`).",
  }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  status: Type.Optional(
    Type.Union([Type.Literal("active"), Type.Literal("canceled")]),
  ),
});

export const calendlyListEventInviteesSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_calendly_list_event_invitees",
  description:
    "List the invitees on a specific Calendly scheduled event, including their names, emails, " +
    "answers to any custom questions, and cancellation status.",
  parameters: PARAMS,
  provider: "calendly",
  async toProxyArgs(params) {
    const qp: Record<string, unknown> = {
      count: Number(params["count"] ?? 20),
    };
    if (params["status"]) qp["status"] = String(params["status"]);
    return {
      method: "GET",
      url: `https://api.calendly.com/scheduled_events/${encodeURIComponent(
        String(params["eventUuid"]),
      )}/invitees`,
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
