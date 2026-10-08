import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

const PARAMS = Type.Object({});

export const linkedinGetCurrentUserSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_linkedin_get_current_user",
  description:
    "Get the authenticated LinkedIn user's profile (id, name, email, picture) via the OIDC /v2/userinfo " +
    "endpoint. Call this first to obtain the `sub` field needed to build `urn:li:person:<sub>` for posting.",
  parameters: PARAMS,
  provider: "linkedin",
  async toProxyArgs() {
    return {
      method: "GET",
      url: "https://api.linkedin.com/v2/userinfo",
      headers: { Accept: "application/json" },
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
