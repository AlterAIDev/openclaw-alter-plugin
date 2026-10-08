import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

// X enforces 280 characters for the standard plan; X Premium allows up to
// 25,000. We accept up to 4,000 here as a defensive cap that covers Premium
// but is still bounded — server-side X will 400 anything that exceeds the
// account's actual limit, and the error surfaces as a BackendError.
const PARAMS = Type.Object({
  text: Type.String({
    minLength: 1,
    maxLength: 4_000,
    description:
      "The tweet body. Standard accounts are capped at 280 characters; " +
      "Premium accounts can post longer. Mentions (@handle) and hashtags (#tag) " +
      "are interpreted by X server-side.",
  }),
  replyToTweetId: Type.Optional(
    Type.String({
      pattern: "^[0-9]{1,25}$",
      description:
        "Optional. Numeric id of the tweet to reply to. The replying user " +
        "must have visibility into the parent tweet's conversation.",
    }),
  ),
});

export const xPostTweetSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_x_post_tweet",
  description:
    "Post a tweet to the authenticated X (Twitter) user's account via POST /2/tweets. " +
    "**HITL-approved — always requires human approval in the Alter wallet before the tweet is " +
    "published.** After calling this tool the user must explicitly approve in the wallet UI; " +
    "the tweet is NOT sent until they do. Requires the `tweet.write` scope on the connected " +
    "X grant. Pass `replyToTweetId` to reply to an existing tweet (the user must have access " +
    "to the parent conversation).",
  parameters: PARAMS,
  provider: "twitter",
  hitl: true,
  async toProxyArgs(params) {
    const text = String(params["text"]);
    const replyTo = params["replyToTweetId"] as string | undefined;
    const body: Record<string, unknown> = { text };
    if (replyTo) {
      body["reply"] = { in_reply_to_tweet_id: replyTo };
    }
    return {
      method: "POST",
      url: "https://api.x.com/2/tweets",
      jsonBody: body,
      headers: { "Content-Type": "application/json" },
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
