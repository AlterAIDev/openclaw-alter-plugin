import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({
  channel: Type.String({ minLength: 1, maxLength: 64 }),
  text: Type.String({ minLength: 1, maxLength: 40_000 }),
  threadTs: Type.Optional(Type.String({ maxLength: 32 })),
});

export const slackPostMessageSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_slack_post_message",
  description:
    "Post a message to a Slack channel or DM. HITL-approved. channel accepts a channel id (C0123…), user id (U0123…), or @handle.",
  parameters: PARAMS,
  provider: "slack",
  hitl: true,
  async toProxyArgs(params) {
    const body: Record<string, unknown> = {
      channel: String(params["channel"]),
      text: String(params["text"]),
    };
    if (typeof params["threadTs"] === "string") body["thread_ts"] = String(params["threadTs"]);
    return {
      method: "POST",
      url: "https://slack.com/api/chat.postMessage",
      jsonBody: body,
      headers: { "Content-Type": "application/json; charset=utf-8" },
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
