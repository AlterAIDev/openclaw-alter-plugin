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
  active: Type.Optional(Type.Boolean()),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const calendlyListEventTypesSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_calendly_list_event_types",
  description:
    "List the bookable event types (meeting templates) the user offers on Calendly. " +
    "Returns scheduling URLs callers can share with invitees.",
  parameters: PARAMS,
  provider: "calendly",
  async toProxyArgs(params) {
    const qp: Record<string, unknown> = {
      user: String(params["userUri"]),
      count: Number(params["count"] ?? 20),
    };
    if (typeof params["active"] === "boolean") qp["active"] = params["active"];
    return {
      method: "GET",
      url: "https://api.calendly.com/event_types",
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
