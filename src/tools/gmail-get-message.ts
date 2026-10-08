import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 64 }),
  format: Type.Optional(
    Type.Union([
      Type.Literal("metadata"),
      Type.Literal("full"),
      Type.Literal("minimal"),
    ]),
  ),
});

export const gmailGetMessageSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_gmail_get_message",
  description:
    "Fetch a single Gmail message by id. format=\"metadata\" (default) returns headers (Subject/From/To/Date) and snippet without the body — cheap and usually enough. format=\"full\" returns the full body parts. Pair with alter_gmail_search to expand stub IDs into readable previews.",
  parameters: PARAMS,
  provider: "google",
  async toProxyArgs(params) {
    const fmt = (params["format"] as string | undefined) ?? "metadata";
    const qp: Record<string, unknown> = { format: fmt };
    if (fmt === "metadata") {
      qp["metadataHeaders"] = ["Subject", "From", "To", "Date"];
    }
    return {
      method: "GET",
      url: `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(
        String(params["id"]),
      )}`,
      queryParams: qp,
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
