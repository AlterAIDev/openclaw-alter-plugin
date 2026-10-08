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
  reason: Type.Optional(Type.String({ maxLength: 1024 })),
});

export const calendlyCancelEventSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_calendly_cancel_event",
  description:
    "Cancel a Calendly scheduled event. Invitees are notified by Calendly. HITL-approved.",
  parameters: PARAMS,
  provider: "calendly",
  hitl: true,
  async toProxyArgs(params) {
    const body: Record<string, unknown> = {};
    if (typeof params["reason"] === "string") body["reason"] = params["reason"];
    return {
      method: "POST",
      url: `https://api.calendly.com/scheduled_events/${encodeURIComponent(
        String(params["eventUuid"]),
      )}/cancellation`,
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
