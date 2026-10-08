import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  userId: Type.String({
    pattern: "^[0-9]{1,25}$",
    description:
      "Numeric X user id whose recent tweets to fetch. NOT the @username — " +
      "call alter_x_get_current_user (for the signed-in user) or use the X " +
      "users/by/username endpoint elsewhere to resolve a handle first.",
  }),
  maxResults: Type.Optional(
    Type.Integer({
      minimum: 5,
      maximum: 100,
      default: 10,
      description: "Tweets per page. X clamps this to [5, 100].",
    }),
  ),
});

export const xListUserTweetsSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_x_list_user_tweets",
  description:
    "List recent tweets by a specific X (Twitter) user via GET /2/users/:id/tweets. " +
    "Returns tweets in reverse-chronological order with id, text, and created_at. " +
    "⚠️ X's home-timeline feed is NOT exposed to standard API apps — this tool only " +
    "returns tweets authored by the userId you pass. To approximate a 'feed', call " +
    "this against a curated set of user ids. Most useful for the signed-in user's own " +
    "tweets (userId = id returned by alter_x_get_current_user).",
  parameters: PARAMS,
  provider: "twitter",
  async toProxyArgs(params) {
    const userId = String(params["userId"]);
    const maxResults = (params["maxResults"] as number | undefined) ?? 10;
    return {
      method: "GET",
      url: `https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets`,
      queryParams: {
        max_results: maxResults,
        "tweet.fields": "id,text,created_at,public_metrics",
        exclude: "retweets,replies",
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
