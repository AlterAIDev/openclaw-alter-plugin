import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  q: Type.String({ minLength: 1, maxLength: 512 }),
  perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const githubSearchIssuesSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_github_search_issues",
  description:
    "Search GitHub issues and pull requests with GitHub search syntax (e.g. \"repo:foo/bar is:open label:bug\").",
  parameters: PARAMS,
  provider: "github",
  async toProxyArgs(params) {
    return {
      method: "GET",
      url: "https://api.github.com/search/issues",
      queryParams: {
        q: String(params["q"]),
        per_page: Number(params["perPage"] ?? 10),
      },
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
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
