import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 512 }),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const notionSearchSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_notion_search",
  description:
    "Search the user's Notion workspace for pages and databases matching a query string.",
  parameters: PARAMS,
  provider: "notion",
  async toProxyArgs(params) {
    return {
      method: "POST",
      url: "https://api.notion.com/v1/search",
      jsonBody: {
        query: String(params["query"]),
        page_size: Number(params["pageSize"] ?? 10),
      },
      headers: {
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
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
