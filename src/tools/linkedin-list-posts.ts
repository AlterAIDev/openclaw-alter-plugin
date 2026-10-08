import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  authorUrns: Type.Array(
    Type.String({ minLength: 16, maxLength: 128 }),
    {
      minItems: 1,
      maxItems: 10,
      description:
        "List of author URNs whose posts to fetch, e.g. [`urn:li:person:<sub>`]. " +
        "Use alter_linkedin_get_current_user to obtain the connected user's `sub`. " +
        "Note: reading posts by other users requires that those users have made posts " +
        "with public visibility, OR that your LinkedIn app has elevated permissions.",
    },
  ),
  count: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 50, default: 20 }),
  ),
});

export const linkedinListPostsSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_linkedin_list_posts",
  description:
    "List recent posts by one or more LinkedIn authors via /v2/ugcPosts?q=authors. " +
    "Use this to find recent posts to engage with, summarize, or track. " +
    "⚠️ LinkedIn's home-feed timeline is NOT exposed to public API apps — this tool only " +
    "returns posts authored by the URNs you specify. To approximate a 'feed', call this " +
    "with a curated list of authors the user follows. Most useful for the user's own posts " +
    "(authorUrn = their own urn:li:person:<sub>).",
  parameters: PARAMS,
  provider: "linkedin",
  async toProxyArgs(params) {
    const authors = params["authorUrns"] as string[];
    const count = (params["count"] as number | undefined) ?? 20;
    const authorsParam = `List(${authors.map((a) => encodeURIComponent(a)).join(",")})`;
    return {
      method: "GET",
      url: "https://api.linkedin.com/v2/ugcPosts",
      queryParams: {
        q: "authors",
        authors: authorsParam,
        count,
        sortBy: "LAST_MODIFIED",
      },
      headers: {
        Accept: "application/json",
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
