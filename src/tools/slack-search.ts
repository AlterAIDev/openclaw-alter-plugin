import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 512 }),
  count: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const slackSearchSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_slack_search",
  description:
    "Search the user's Slack workspaces for messages matching a query. Uses search.messages (requires search:read on a user token).",
  parameters: PARAMS,
  provider: "slack",
  async toProxyArgs(params) {
    return {
      method: "GET",
      url: "https://slack.com/api/search.messages",
      queryParams: {
        query: String(params["query"]),
        count: Number(params["count"] ?? 10),
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
