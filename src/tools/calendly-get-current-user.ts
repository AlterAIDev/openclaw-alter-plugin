import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({});

export const calendlyGetCurrentUserSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_calendly_get_current_user",
  description:
    "Get the authenticated Calendly user's profile, including their `uri` and `current_organization` " +
    "URIs. Call this first to obtain identifiers required by the other Calendly tools.",
  parameters: PARAMS,
  provider: "calendly",
  async toProxyArgs() {
    return {
      method: "GET",
      url: "https://api.calendly.com/users/me",
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
