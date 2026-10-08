import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({});

export const xGetCurrentUserSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_x_get_current_user",
  description:
    "Get the authenticated X (Twitter) user's profile via GET /2/users/me. " +
    "Returns the numeric id, @username, and display name. Call this first to obtain " +
    "the user's id when subsequent tools need it (e.g. alter_x_list_user_tweets).",
  parameters: PARAMS,
  provider: "twitter",
  async toProxyArgs() {
    return {
      method: "GET",
      url: "https://api.x.com/2/users/me",
      queryParams: {
        "user.fields": "id,name,username,profile_image_url,verified",
      },
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
