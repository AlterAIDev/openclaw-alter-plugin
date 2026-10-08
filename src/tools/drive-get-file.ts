import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  fileId: Type.String({ minLength: 1, maxLength: 128 }),
});

export const driveGetFileSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_drive_get_file",
  description:
    "Fetch a Google Drive file's metadata. Use alter_drive_search first to discover ids.",
  parameters: PARAMS,
  provider: "google",
  async toProxyArgs(params) {
    return {
      method: "GET",
      url: `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        String(params["fileId"]),
      )}`,
      queryParams: { fields: "id,name,mimeType,size,modifiedTime,webViewLink,owners(emailAddress)" },
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
