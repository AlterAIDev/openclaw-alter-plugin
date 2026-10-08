import { hintSuffix, KEY_SCOPE_MESSAGE, keyScopeLog, missingKeyScopes } from "../alter-client.js";
import { LoginRateLimitedError } from "./login-rate-limit.js";

/** What a tool returns when it needs the user to sign in. */
export interface SignInPrompt {
  /**
   * False when a link was minted. The link is the actionable next step the
   * agent must relay verbatim; marking it isError makes the model treat the
   * tool as broken ("the connectors fail with a sign-in error") and bury the
   * link instead of surfacing it.
   */
  isError: boolean;
  text: string;
}

/**
 * Start a sign-in and word the tool result around its link. `lead` says why
 * the user must sign in. `cantStart` opens the reply when the flow won't start.
 *
 * Shared by the provider tools and the memory tools so the link text, and the
 * rule that a start failure is logged but never echoed, can't drift between
 * them. The failure detail (an SDK or backend message) is for the operator
 * log, not the chat.
 */
export async function signInPrompt(opts: {
  startLogin: () => Promise<string>;
  lead: string;
  cantStart: string;
  /** Receives the operator log line when the flow won't start. */
  warn: (message: string) => void;
  /** Receives the operator log line when the app key is missing a scope. */
  error: (message: string) => void;
}): Promise<SignInPrompt> {
  let url: string;
  try {
    url = await opts.startLogin();
  } catch (e) {
    if (e instanceof LoginRateLimitedError) return { isError: true, text: e.message };
    const scopes = missingKeyScopes(e);
    if (scopes) {
      opts.error(keyScopeLog("start a sign-in", scopes));
      return {
        isError: true,
        text: `${KEY_SCOPE_MESSAGE} Tell the user this plainly; do NOT suggest retrying.`,
      };
    }
    opts.warn(
      "could not start a sign-in: " +
        (e instanceof Error ? `${e.name}: ${e.message}` : String(e)) +
        hintSuffix(e),
    );
    return { isError: true, text: `${opts.cantStart}. Try again shortly.` };
  }
  return {
    isError: false,
    text: `${opts.lead} Click here: ${url}\n(One-time link; expires in 10 minutes. After signing in, ask me again.)`,
  };
}
