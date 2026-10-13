import { Type } from "typebox";
import { Value } from "typebox/value";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  identityTerminal,
  isUserTokenRejected,
  KEY_SCOPE_MESSAGE,
  keyScopeLog,
  missingKeyScopes,
} from "../alter-client.js";
import type { IdentityStore } from "../identity/store.js";
import type { RateLimitStore } from "../rate-limit/store.js";
import { hashIdpSub } from "../identity/sub-hash.js";
import { signInPrompt } from "../identity/sign-in-prompt.js";
import { capToolResultJson } from "../tool-result-cap.js";
import { MemoryScopeError, type MemoryScopeResolver } from "./scope.js";
import type { MemoryStore } from "./store.js";

/**
 * Per-user memory tools.
 *
 * These deliberately do NOT go through `registerAlterTool`: that wrapper's job
 * is to resolve a provider grant and call `Agent.proxyRequest`, and memory does
 * neither — it is local state, and there is no provider to connect. What they DO
 * share is the gate order that matters: channel → identity → (scope) → act.
 *
 * The partition key is never a tool parameter. The LLM asks to remember or
 * recall; Alter decides whose memory that is, from the sealed JWT. See
 * src/memory/scope.ts for why that distinction is the whole feature.
 */

export const MEMORY_TOOL_NAMES = [
  "alter_memory_remember",
  "alter_memory_recall",
  "alter_memory_forget",
] as const;

export interface MemoryToolDeps {
  identities: IdentityStore;
  rateLimit: RateLimitStore;
  memories: MemoryStore;
  scopes: MemoryScopeResolver;
  channelHashSalt: string;
  startLogin: (
    channelKind: string,
    channelUserId: string,
    sessionId: string,
  ) => Promise<string>;
}

interface ToolResultLike {
  isError: boolean;
  content: Array<{ type: "text"; text: string }>;
  /** Present so this shape is assignable to the runtime's AgentToolResult. */
  details?: unknown;
}

const err = (text: string): ToolResultLike => ({
  isError: true,
  content: [{ type: "text", text }],
});
const ok = (text: string): ToolResultLike => ({
  isError: false,
  content: [{ type: "text", text }],
});

const REMEMBER_PARAMS = Type.Object({
  content: Type.String({
    minLength: 1,
    maxLength: 4000,
    description:
      "The fact to remember about this user, in your own words. One self-contained " +
      "statement — it will be shown back to you later without today's conversation.",
  }),
});

const RECALL_PARAMS = Type.Object({
  query: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 200,
      description: "Substring filter. Omit to get this user's most recent memories.",
    }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

const FORGET_PARAMS = Type.Object({
  id: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 64,
      description: "Memory id from alter_memory_recall. Omit with all=true to forget everything.",
    }),
  ),
  all: Type.Optional(
    Type.Boolean({ description: "Forget EVERY memory for this user. Requires no id." }),
  ),
});

/**
 * Resolve the caller: channel-attached → signed in → Alter-derived partition key.
 * Returns a userKey, or a tool result explaining why not.
 */
async function resolveCaller(
  api: OpenClawPluginApi,
  deps: MemoryToolDeps,
  toolName: string,
  ctx: { sessionId: string; channelKind: string; channelUserId: string },
): Promise<{ userKey: string; idpSub: string } | { result: ToolResultLike }> {
  // Start a sign-in and hand back its link (see `signInPrompt`).
  const signIn = async (lead: string, cantStart: string): Promise<{ result: ToolResultLike }> => {
    const prompt = await signInPrompt({
      startLogin: () => deps.startLogin(ctx.channelKind, ctx.channelUserId, ctx.sessionId),
      lead,
      cantStart,
      warn: (m) => api.logger.warn(`[alter] ${toolName} ${m}`),
      error: (m) => api.logger.error(`[alter] ${toolName} ${m}`),
    });
    return { result: prompt.isError ? err(prompt.text) : ok(prompt.text) };
  };

  const link = deps.identities.get(ctx.channelKind, ctx.channelUserId);
  if (!link) {
    return signIn(
      "You need to sign in once before I can remember anything for you.",
      "You need to sign in, but I couldn't start the sign-in flow",
    );
  }
  if (link.jwtExpiresAt < Date.now()) {
    return signIn("Your sign-in expired.", "Your sign-in expired and I couldn't start a new one");
  }

  deps.rateLimit.bindSession(ctx.sessionId, link.appUserId);

  // The partition key. Alter derives it from the JWT — we pass link.appUserId
  // only as a cache bucket, never as the key.
  let userKey: string;
  try {
    userKey = await deps.scopes.resolve(link.appUserId, link.jwt);
  } catch (e) {
    // Alter rejected the sign-in JWT itself. "Try again shortly" would just
    // loop, so offer a fresh sign-in (it won't help while Alter can't reach the
    // IdP's JWKS; see `isUserTokenRejected`). Still fails closed: no key, no
    // memory.
    if (e instanceof MemoryScopeError && isUserTokenRejected(e.cause)) {
      api.logger.warn(
        `[alter] ${toolName} sign-in token rejected by Alter for ` +
          `app_user_h=${hashIdpSub(deps.channelHashSalt, link.idpSub)}: ${e.message}`,
      );
      return signIn(
        "Alter rejected your sign-in, so you need to sign in again.",
        "Alter rejected your sign-in and I couldn't start a new one",
      );
    }
    // The agent key can't resolve identities. No user can reach memory until
    // the operator fixes the key, so "try again shortly" would just loop.
    const scopes = e instanceof MemoryScopeError ? missingKeyScopes(e.cause) : undefined;
    if (scopes) {
      api.logger.error(`[alter] ${toolName} ${keyScopeLog("resolve the memory owner", scopes)}`);
      return {
        result: err(`${KEY_SCOPE_MESSAGE} Tell the user this plainly; do NOT suggest retrying.`),
      };
    }
    // The identity is no longer active. Alter refuses a deprovisioned user
    // outright (403) but returns a suspended one, which `MemoryScopeResolver`
    // then refuses itself. Either way only an administrator can fix it, so
    // "try again shortly" would just loop.
    const inactive =
      e instanceof MemoryScopeError
        ? (identityTerminal(e.cause) ??
          (e.userStatus === "deprovisioned" || e.userStatus === "suspended" ? e.userStatus : undefined))
        : undefined;
    if (inactive !== undefined) {
      api.logger.warn(
        `[alter] ${toolName} refused: identity ${inactive} for ` +
          `app_user_h=${hashIdpSub(deps.channelHashSalt, link.idpSub)}`,
      );
      return {
        result: err(
          `Your Alter identity has been ${inactive}, so I can't use your memory. ` +
            `Signing in again won't help — an administrator must ` +
            `${inactive === "deprovisioned" ? "re-provision" : "reactivate"} the account. ` +
            "Tell the user this plainly; do NOT suggest retrying.",
        ),
      };
    }
    if (e instanceof MemoryScopeError) {
      api.logger.warn(
        `[alter] ${toolName} could not resolve memory scope for ` +
          `app_user_h=${hashIdpSub(deps.channelHashSalt, link.idpSub)}: ${e.message}`,
      );
      // Fail CLOSED. Without a verified key there is no correct partition to
      // read or write, and inventing one is the bug this design exists to avoid.
      return {
        result: err(
          "I couldn't verify your identity with Alter, so I won't touch memory. Try again shortly.",
        ),
      };
    }
    throw e;
  }
  return { userKey, idpSub: link.idpSub };
}

export function registerMemoryTools(api: OpenClawPluginApi, deps: MemoryToolDeps): void {
  const factory =
    (
      name: (typeof MEMORY_TOOL_NAMES)[number],
      description: string,
      parameters: typeof REMEMBER_PARAMS | typeof RECALL_PARAMS | typeof FORGET_PARAMS,
      run: (
        userKey: string,
        params: Record<string, unknown>,
      ) => ToolResultLike,
    ): OpenClawPluginToolFactory =>
    (ctx: OpenClawPluginToolContext) => {
      const sessionId = ctx.sessionId;
      const channelKind = ctx.messageChannel;
      const channelUserId = ctx.requesterSenderId;

      return {
        name,
        label: name,
        description,
        parameters,
        ownerOnly: false,
        async execute(_id: string, rawParams: unknown) {
          if (!sessionId || !channelKind || !channelUserId) {
            return err(
              `${name} requires a channel-attached chat session. ` +
                "(No sessionId/messageChannel/requesterSenderId in tool context.)",
            );
          }
          const params = (rawParams ?? {}) as Record<string, unknown>;
          if (!Value.Check(parameters, params)) {
            const first = Value.Errors(parameters, params)[0];
            return err(
              `Invalid arguments to ${name}: ${
                first ? `${first.instancePath || "<root>"}: ${first.message}` : "(no detail)"
              }.`,
            );
          }
          const caller = await resolveCaller(api, deps, name, {
            sessionId,
            channelKind,
            channelUserId,
          });
          if ("result" in caller) return caller.result;
          try {
            return run(caller.userKey, params);
          } catch (e) {
            api.logger.warn(
              `[alter] ${name} failed for ` +
                `app_user_h=${hashIdpSub(deps.channelHashSalt, caller.idpSub)}: ` +
                (e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
            );
            return err("I couldn't reach your memory just now. Try again shortly.");
          }
        },
      } as AnyAgentTool;
    };

  api.registerTool(
    factory(
      "alter_memory_remember",
      "Remember one durable fact about the CURRENT user (a preference, a project, how they " +
        "like things done). Stored privately to them and available in future conversations. " +
        "Don't store secrets, and don't store things that are only true today.",
      REMEMBER_PARAMS,
      (userKey, params) => {
        const row = deps.memories.add(userKey, params["content"] as string);
        return ok(`Remembered. (id: ${row.id})`);
      },
    ),
    { name: "alter_memory_remember" },
  );

  api.registerTool(
    factory(
      "alter_memory_recall",
      "Recall what you know about the CURRENT user. Returns only their own memories — " +
        "never another user's. Use before answering anything that depends on their " +
        "preferences or past context.",
      RECALL_PARAMS,
      (userKey, params) => {
        // Value.Check has already passed, so `query` is a string or absent.
        const query = typeof params["query"] === "string" ? params["query"] : undefined;
        const rows = deps.memories.search(
          userKey,
          query,
          (params["limit"] as number | undefined) ?? 20,
        );
        if (rows.length === 0) {
          return ok(
            query
              ? `No memories matching "${query}".`
              : "Nothing remembered for this user yet.",
          );
        }
        return ok(
          capToolResultJson(
            rows.map((r) => ({
              id: r.id,
              content: r.content,
              remembered: new Date(r.createdAtMs).toISOString(),
            })),
            { maxBytes: 8192 },
          ),
        );
      },
    ),
    { name: "alter_memory_recall" },
  );

  api.registerTool(
    factory(
      "alter_memory_forget",
      "Forget one memory (by id from alter_memory_recall) or all of them (all=true). " +
        "Only ever affects the CURRENT user's memories.",
      FORGET_PARAMS,
      (userKey, params) => {
        const all = params["all"] === true;
        const id = params["id"] as string | undefined;
        if (all && id) {
          return err("Pass either id or all=true, not both.");
        }
        if (all) {
          const n = deps.memories.forgetAll(userKey);
          return ok(`Forgot ${n} ${n === 1 ? "memory" : "memories"}.`);
        }
        if (!id) return err("Pass an id (from alter_memory_recall), or all=true.");
        return deps.memories.delete(userKey, id)
          ? ok("Forgotten.")
          : err("No memory of yours with that id.");
      },
    ),
    { name: "alter_memory_forget" },
  );
}
