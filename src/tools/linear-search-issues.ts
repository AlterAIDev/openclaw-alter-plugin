import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 256 }),
  first: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

const SEARCH_QUERY = `query Search($q: String!, $first: Int!) {
  issues(
    filter: {
      or: [
        { title: { containsIgnoreCase: $q } }
        { description: { containsIgnoreCase: $q } }
      ]
    }
    first: $first
    orderBy: updatedAt
  ) {
    nodes {
      id
      identifier
      title
      url
      updatedAt
      state { name type }
      assignee { name }
      team { id key name }
    }
  }
}`;

export const linearSearchIssuesSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_linear_search_issues",
  description: "Search the user's Linear workspace for issues by free-text query.",
  parameters: PARAMS,
  provider: "linear",
  async toProxyArgs(params) {
    return {
      method: "POST",
      url: "https://api.linear.app/graphql",
      jsonBody: {
        query: SEARCH_QUERY,
        variables: {
          q: String(params["query"]),
          first: Number(params["first"] ?? 10),
        },
      },
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
