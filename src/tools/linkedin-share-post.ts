import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  authorUrn: Type.String({
    minLength: 16,
    maxLength: 128,
    description:
      "URN of the post author, e.g. `urn:li:person:<sub>`. Get `sub` from alter_linkedin_get_current_user.",
  }),
  text: Type.String({ minLength: 1, maxLength: 3000 }),
  visibility: Type.Optional(
    Type.Union(
      [Type.Literal("PUBLIC"), Type.Literal("CONNECTIONS")],
      { default: "PUBLIC" },
    ),
  ),
});

export const linkedinSharePostSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_linkedin_share_post",
  description:
    "Share a text post to the authenticated LinkedIn user's feed via /v2/ugcPosts. " +
    "**HITL-approved — always requires human approval in the Alter wallet before the post is published.** " +
    "After calling this tool the user must explicitly approve in the wallet UI; the post is NOT " +
    "sent until they do. Requires the `w_member_social` scope on the connected LinkedIn grant. " +
    "authorUrn must be the user's own URN (urn:li:person:<sub>) — posting on behalf of " +
    "organizations needs different scopes.",
  parameters: PARAMS,
  provider: "linkedin",
  hitl: true,
  async toProxyArgs(params) {
    const author = String(params["authorUrn"]);
    const text = String(params["text"]);
    const visibility = (params["visibility"] as string | undefined) ?? "PUBLIC";
    return {
      method: "POST",
      url: "https://api.linkedin.com/v2/ugcPosts",
      jsonBody: {
        author,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text },
            shareMediaCategory: "NONE",
          },
        },
        visibility: {
          "com.linkedin.ugc.MemberNetworkVisibility": visibility,
        },
      },
      headers: {
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
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
