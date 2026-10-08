import { Type } from "typebox";
import type { ApprovalResult } from "@alter-ai/alter-sdk";
import type { AlterToolSpec } from "./base.js";

// Reject any CR/LF in header-bound fields. Gmail decodes our base64url
// payload and re-parses RFC822 headers — a stray \r\n in `to` or `subject`
// would inject arbitrary headers (Bcc, Reply-To, ...). The body has no
// such constraint because it follows the empty header-terminator line.
const NO_CRLF = "^[^\\r\\n]+$";

const PARAMS = Type.Object({
  to: Type.String({ minLength: 3, maxLength: 320, pattern: NO_CRLF }),
  subject: Type.String({ minLength: 1, maxLength: 256, pattern: NO_CRLF }),
  body: Type.String({ minLength: 1, maxLength: 64_000 }),
});

function assertNoCrlf(field: string, value: string): void {
  if (value.includes("\r") || value.includes("\n")) {
    throw new Error(`gmail-send: ${field} must not contain CR/LF (header injection)`);
  }
}

function buildRfc822(args: { to: string; subject: string; body: string }): string {
  // Defense-in-depth: the TypeBox pattern already rejects CR/LF, but if a
  // future caller bypasses schema validation we still want to refuse.
  assertNoCrlf("to", args.to);
  assertNoCrlf("subject", args.subject);
  return [
    `To: ${args.to}`,
    `Subject: ${args.subject}`,
    "MIME-Version: 1.0",
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    args.body,
  ].join("\r\n");
}

function signatureBlock(): string {
  // Operator-controlled signature appended to every outgoing email body.
  // Set via the `ALTER_GMAIL_SIGNATURE` env var on the plugin host.
  //
  // RFC 3676 §4.3 sig separator: a line consisting of exactly "-- " (dash
  // dash space). MUAs (Gmail, Apple Mail, Thunderbird) use this convention
  // to hide the signature in reply quoting.
  //
  // Multi-tenant note: this is a per-deployment shortcut. The strictly
  // multi-tenant-correct shape would be to fetch each user's own signature
  // from `GET /gmail/v1/users/me/settings/sendAs` (the primary alias's
  // `signature` field, HTML) and cache it per app_user. That avoids one
  // deployment serving an operator-defined sig to every user. For a
  // single-user deployment the env var is fine.
  const sig = process.env["ALTER_GMAIL_SIGNATURE"]?.trim();
  if (!sig) return "";
  return `\n\n-- \n${sig}`;
}

export const gmailSendSpec: AlterToolSpec<typeof PARAMS> = {
  name: "alter_gmail_send",
  description: "Send an email from the user's connected Gmail account. HITL-approved.",
  parameters: PARAMS,
  provider: "google",
  hitl: true,
  async toProxyArgs(params) {
    const to = String(params["to"]);
    const subject = String(params["subject"]);
    // Append signature AFTER schema validation runs in base.ts (the 64KB
    // body limit is on LLM-provided input; the operator-set sig is trusted
    // additive content).
    const body = String(params["body"]) + signatureBlock();
    return {
      method: "POST",
      url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      jsonBody: {
        raw: Buffer.from(buildRfc822({ to, subject, body }), "utf8").toString("base64url"),
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
