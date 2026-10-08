import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  owner: Type.String({ minLength: 1, maxLength: 64 }),
  repo: Type.String({ minLength: 1, maxLength: 100 }),
  issueNumber: Type.Integer({ minimum: 1 }),
  body: Type.String({ minLength: 1, maxLength: 64_000 }),
});

export const githubCreateCommentSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_github_create_comment",
  description:
    "Comment on a GitHub issue or pull request in {owner}/{repo}#{issueNumber}. HITL-approved.",
  parameters: PARAMS,
  provider: "github",
  hitl: true,
  async toProxyArgs(params) {
    return {
      method: "POST",
      url: `https://api.github.com/repos/${encodeURIComponent(
        String(params["owner"]),
      )}/${encodeURIComponent(String(params["repo"]))}/issues/${Number(
        params["issueNumber"],
      )}/comments`,
      jsonBody: { body: String(params["body"]) },
      headers: {
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
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
