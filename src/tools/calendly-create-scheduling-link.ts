import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  eventTypeUri: Type.String({
    minLength: 1,
    maxLength: 256,
    description:
      "Calendly event type URI to schedule against, e.g. `https://api.calendly.com/event_types/<uuid>`. " +
      "Get this from `alter_calendly_list_event_types`.",
  }),
  maxEventCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
});

export const calendlyCreateSchedulingLinkSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_calendly_create_scheduling_link",
  description:
    "Create a single-use (or limited-use) Calendly scheduling link for a given event type that can " +
    "be shared with invitees. HITL-approved.",
  parameters: PARAMS,
  provider: "calendly",
  hitl: true,
  async toProxyArgs(params) {
    const body: Record<string, unknown> = {
      max_event_count: Number(params["maxEventCount"] ?? 1),
      owner: String(params["eventTypeUri"]),
      owner_type: "EventType",
    };
    return {
      method: "POST",
      url: "https://api.calendly.com/scheduling_links",
      jsonBody: body,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
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
