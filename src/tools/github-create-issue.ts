import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  owner: Type.String({ minLength: 1, maxLength: 64 }),
  repo: Type.String({ minLength: 1, maxLength: 100 }),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  body: Type.Optional(Type.String({ maxLength: 64_000 })),
  labels: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 50 }), { maxItems: 20 })),
});

export const githubCreateIssueSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_github_create_issue",
  description: "Open a GitHub issue in {owner}/{repo}. HITL-approved.",
  parameters: PARAMS,
  provider: "github",
  hitl: true,
  async toProxyArgs(params) {
    const body: Record<string, unknown> = { title: String(params["title"]) };
    if (typeof params["body"] === "string") body["body"] = params["body"];
    if (Array.isArray(params["labels"])) body["labels"] = params["labels"];
    return {
      method: "POST",
      url: `https://api.github.com/repos/${encodeURIComponent(
        String(params["owner"]),
      )}/${encodeURIComponent(String(params["repo"]))}/issues`,
      jsonBody: body,
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
