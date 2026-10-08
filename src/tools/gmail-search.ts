import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  query: Type.String({ minLength: 1, maxLength: 512 }),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
});

export const gmailSearchSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_gmail_search",
  description: "Search the user's Gmail messages with a Gmail-search query string.",
  parameters: PARAMS,
  provider: "google",
  async toProxyArgs(params) {
    return {
      method: "GET",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages",
      queryParams: {
        q: String(params["query"]),
        maxResults: Number(params["maxResults"] ?? 10),
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
