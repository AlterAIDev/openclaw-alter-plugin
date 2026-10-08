import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  parentPageId: Type.String({ minLength: 32, maxLength: 64 }),
  title: Type.String({ minLength: 1, maxLength: 256 }),
  bodyMarkdown: Type.Optional(Type.String({ maxLength: 32_000 })),
});

export const notionCreatePageSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_notion_create_page",
  description:
    "Create a Notion page as a child of an existing page. HITL-approved. parentPageId is the 32-char Notion page id.",
  parameters: PARAMS,
  provider: "notion",
  hitl: true,
  async toProxyArgs(params) {
    const title = String(params["title"]);
    const body: Record<string, unknown> = {
      parent: { page_id: String(params["parentPageId"]) },
      properties: {
        title: { title: [{ type: "text", text: { content: title } }] },
      },
    };
    const md = params["bodyMarkdown"];
    if (typeof md === "string" && md.length > 0) {
      body["children"] = [
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: md } }] },
        },
      ];
    }
    return {
      method: "POST",
      url: "https://api.notion.com/v1/pages",
      jsonBody: body,
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
