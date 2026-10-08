import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  q: Type.String({ minLength: 1, maxLength: 512 }),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export const driveSearchSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_drive_search",
  description:
    "Search the user's Google Drive with the Drive v3 query syntax (e.g. \"name contains 'budget' and mimeType='application/pdf'\").",
  parameters: PARAMS,
  provider: "google",
  async toProxyArgs(params) {
    return {
      method: "GET",
      url: "https://www.googleapis.com/drive/v3/files",
      queryParams: {
        q: String(params["q"]),
        pageSize: Number(params["pageSize"] ?? 10),
        fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
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
