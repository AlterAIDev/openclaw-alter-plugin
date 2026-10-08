import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  teamId: Type.String({ minLength: 8, maxLength: 64 }),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  description: Type.Optional(Type.String({ maxLength: 32_000 })),
});

const CREATE_MUTATION = `mutation CreateIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url title }
  }
}`;

export const linearCreateIssueSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_linear_create_issue",
  description:
    "Create a Linear issue in the given team. HITL-approved. teamId is the Linear team UUID (not the key).",
  parameters: PARAMS,
  provider: "linear",
  hitl: true,
  async toProxyArgs(params) {
    const input: Record<string, unknown> = {
      teamId: String(params["teamId"]),
      title: String(params["title"]),
    };
    if (typeof params["description"] === "string") input["description"] = params["description"];
    return {
      method: "POST",
      url: "https://api.linear.app/graphql",
      jsonBody: { query: CREATE_MUTATION, variables: { input } },
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
