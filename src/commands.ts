import type { App, Agent, ApprovalStatus } from "@alter-ai/alter-sdk";
import type {
  OpenClawPluginApi,
  PluginCommandContext,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import type { AlterPluginConfig } from "./config.js";
import type { IdentityStore } from "./identity/store.js";
import type { GrantsStore } from "./grants/store.js";
import {
  numberedGateLinks,
  outstandingGates,
  type PendingApprovalLock,
} from "./pending-approval-lock.js";
import {
  currentUserJwt,
  hintSuffix,
  identityTerminal,
  isUserTokenRejected,
  KEY_SCOPE_MESSAGE,
  keyScopeLog,
  missingKeyScopes,
} from "./alter-client.js";
import {
  AUTH_SESSION_DEFAULT_TTL_MS,
  AuthPoller,
  AuthSessionStore,
} from "./identity/auth-session.js";
import {
  buildConnectReturnUrl,
  newConnectStatePayload,
} from "./grants/connect-routes.js";
import type { PendingConnectsStore } from "./grants/pending-connects.js";
import { listAllGrants } from "./grants/grant-query.js";
import { newCsrfNonce, type StateHmac } from "./grants/state-hmac.js";
import type { AuthLoginRateLimit } from "./identity/login-rate-limit.js";
import {
  OAUTH_PROVIDER_IDS,
  matchProviderId,
  providerDisplayName,
  type ProviderId,
} from "./tools/providers.js";

export interface CommandsDeps {
  cfg: AlterPluginConfig;
  app: App;
  agent: Agent;
  identities: IdentityStore;
  grants: GrantsStore;
  pending: PendingConnectsStore;
  approvalLock: PendingApprovalLock;
  stateHmac: StateHmac;
  authSessions: AuthSessionStore;
  authPoller: AuthPoller;
  loginRateLimit: AuthLoginRateLimit;
}

function reply(text: string, isError = false): PluginCommandResult {
  return { text, isError };
}

type CommandLog = Pick<OpenClawPluginApi["logger"], "warn" | "error">;

/**
 * The reply for a command step that threw, e.g. `failureReply(log, "list
 * connections", e)`. The error itself goes to the operator log only: an SDK or
 * backend message carries internal detail, the same reason the tools never
 * echo one.
 *
 * Three failures get their own reply, because the generic "try again" would
 * send the user round in circles: an Alter API key that is missing a scope
 * (only the operator can help), Alter rejecting the user's sign-in (only a new
 * sign-in can help, if anything can) and an identity that is no longer active
 * (only an administrator can help).
 */
function failureReply(log: CommandLog, action: string, e: unknown): PluginCommandResult {
  const scopes = missingKeyScopes(e);
  if (scopes) {
    log.error(`[alter] /alter ${keyScopeLog(action, scopes)}`);
    return reply(KEY_SCOPE_MESSAGE, true);
  }
  log.warn(
    `[alter] /alter could not ${action}: ` +
      (e instanceof Error ? `${e.name}: ${e.message}` : String(e)) +
      hintSuffix(e),
  );
  if (isUserTokenRejected(e)) {
    return reply("Alter rejected your sign-in. Run /alter login to sign in again, then retry.", true);
  }
  const terminal = identityTerminal(e);
  if (terminal !== undefined) {
    return reply(
      `Your Alter identity has been ${terminal}. An administrator must ` +
        `${terminal === "deprovisioned" ? "re-provision" : "reactivate"} the account; ` +
        "signing in again won't help.",
      true,
    );
  }
  return reply(
    `Couldn't ${action}. Try again shortly; if it keeps failing, ask the operator to check the gateway log.`,
    true,
  );
}

interface ChannelCtx {
  channelKind: string;
  channelUserId: string;
  sessionId: string;
}

function requireChannel(ctx: PluginCommandContext): ChannelCtx | undefined {
  // Slash commands (e.g. Discord native) don't carry a sessionId — they're
  // ephemeral interactions, not chat-session messages. Channel + senderId are
  // the only fields we strictly need; synthesize a stable session key from
  // (channel, senderId) when sessionId is absent.
  if (!ctx.channel || !ctx.senderId) return undefined;
  const sessionId = ctx.sessionId ?? `cmd:${ctx.channel}:${ctx.senderId}`;
  return {
    channelKind: ctx.channel,
    channelUserId: ctx.senderId,
    sessionId,
  };
}

function noChannelMsg(): PluginCommandResult {
  return reply(
    "This command needs a channel-attached chat session (no channel/sender/session in context).",
    true,
  );
}

const HELP_TEXT = [
  "Just talk to me — ask me to do something (e.g. \"send an email to bob about lunch\"),",
  "and I'll prompt you to sign in or connect a provider as needed. No typing required.",
  "",
  "Slash commands (you usually don't need these):",
  "  /alter connect              — show all providers with one-click connect links",
  "  /alter connect <provider>   — quick-connect one provider (e.g. linkedin, gmail)",
  "  /alter connections          — list your active connections",
  "  /alter connections revoke <id> — revoke a connection",
  "  /alter wallet               — open your Alter wallet",
  "  /alter status               — show link state + pending approval",
  "  /alter status clear         — clear a stuck pending-approval lock",
  "  /alter login                — manually re-link this channel (rarely needed)",
].join("\n");

async function doLogin(
  deps: CommandsDeps,
  log: CommandLog,
  ch: ChannelCtx,
): Promise<PluginCommandResult> {
  const decision = deps.loginRateLimit.check(ch.channelKind, ch.channelUserId);
  if (!decision.allowed) {
    return reply(
      `Too many sign-in attempts. Try again in ~${decision.retryAfterSeconds}s.`,
      true,
    );
  }
  let session: { authUrl: string; sessionToken: string };
  try {
    session = await deps.app.createAuthSession();
  } catch (e) {
    return failureReply(log, "start sign-in", e);
  }
  deps.authSessions.insert({
    sessionToken: session.sessionToken,
    channelKind: ch.channelKind,
    channelUserId: ch.channelUserId,
    chatSessionId: ch.sessionId,
    authUrl: session.authUrl,
    iatMs: Date.now(),
    ttlMs: AUTH_SESSION_DEFAULT_TTL_MS,
    status: "pending",
  });
  const justInserted = deps.authSessions.get(session.sessionToken);
  if (justInserted) deps.authPoller.start(justInserted);
  return reply(
    `Sign in here to link this channel: ${session.authUrl}\n` +
      `(One-time link; expires in 10 minutes. After signing in, ask me again — ` +
      `I'll be ready as soon as Alter returns your session.)`,
  );
}

/** Build a one-time connect URL for a single provider. Inserts the pending row. */
async function createConnectUrlForProvider(
  deps: CommandsDeps,
  ch: ChannelCtx,
  link: { appUserId: string; jwt: string },
  provider: ProviderId,
): Promise<string> {
  const csrfNonce = newCsrfNonce();
  const statePayload = newConnectStatePayload({
    csrfNonce,
    sessionId: ch.sessionId,
    channelKind: ch.channelKind,
    channelUserId: ch.channelUserId,
    appUserId: link.appUserId,
    provider,
  });
  const stateToken = deps.stateHmac.sign(statePayload);
  const returnUrl = buildConnectReturnUrl(deps.cfg, stateToken);
  const session = await currentUserJwt.run(link.jwt, async () =>
    deps.agent.createConnectSession({
      allowedProviders: [provider],
      returnUrl,
    }),
  );
  deps.pending.insert({
    csrfNonce,
    sessionId: ch.sessionId,
    appUserId: link.appUserId,
    provider,
    iatMs: statePayload.iatMs,
    ttlMs: statePayload.ttlMs,
  });
  return session.connectUrl;
}

async function doConnect(
  deps: CommandsDeps,
  log: CommandLog,
  ch: ChannelCtx,
  providerArg: string,
): Promise<PluginCommandResult> {
  const link = deps.identities.get(ch.channelKind, ch.channelUserId);
  if (!link || link.jwtExpiresAt < Date.now()) {
    return doLogin(deps, log, ch);
  }

  // No arg → show the menu (everything in PROVIDERS, one-click links for unconnected).
  if (!providerArg) {
    return doConnectMenu(deps, log, ch, link);
  }

  // Fuzzy-match the arg to a canonical id ("LinkedIn" / "linked-in" → "linkedin").
  const provider = matchProviderId(providerArg);
  if (!provider) {
    const known = OAUTH_PROVIDER_IDS.map(providerDisplayName).join(", ");
    return reply(
      `Unknown provider "${providerArg}". Available: ${known}.\n` +
        `Type /alter connect (no args) to see one-click connect links for each.`,
      true,
    );
  }

  let connectUrl: string;
  try {
    connectUrl = await createConnectUrlForProvider(deps, ch, link, provider);
  } catch (e) {
    return failureReply(log, `start ${providerDisplayName(provider)} connect`, e);
  }
  return reply(
    `Connect ${providerDisplayName(provider)} here: ${connectUrl}\n` +
      `(If the account is already connected to Alter you'll see a quick ` +
      `confirmation screen instead of a full sign-in — that's expected; use ` +
      `"Use a different account" there to switch accounts. After completing ` +
      `the flow you'll be redirected back; then ask me again.)`,
  );
}

async function doConnectMenu(
  deps: CommandsDeps,
  log: CommandLog,
  ch: ChannelCtx,
  link: { appUserId: string; jwt: string },
): Promise<PluginCommandResult> {
  // Source of truth for "what's connected": Alter Vault, not the local grants
  // cache (cache might be stale or missing entries for grants made via a
  // different channel). This is the USER's base connections (App view) — the
  // unit a user connects and manages; a base connection is what the connect
  // flow then delegates the agent onto.
  const connectedIds = new Set<string>();
  try {
    const grants = await currentUserJwt.run(link.jwt, async () =>
      listAllGrants(deps.app),
    );
    for (const g of grants) {
      if (g.grantKind === "oauth" && g.status === "active") connectedIds.add(g.providerId);
    }
  } catch (e) {
    // Non-fatal: just show everything as "available" if listGrants fails.
    log.warn(
      "[alter] /alter connect menu could not list connections: " +
        (e instanceof Error ? `${e.name}: ${e.message}` : String(e)) +
        hintSuffix(e),
    );
  }

  const connected = OAUTH_PROVIDER_IDS.filter((id) => connectedIds.has(id));
  const available = OAUTH_PROVIDER_IDS.filter((id) => !connectedIds.has(id));

  // Generate connect URLs in parallel. Errors per-provider are captured, not thrown,
  // so one bad provider doesn't kill the whole menu.
  const urlResults = await Promise.all(
    available.map(async (id) => {
      try {
        const url = await createConnectUrlForProvider(deps, ch, link, id);
        return { id, url, error: undefined as unknown };
      } catch (e) {
        return { id, url: null, error: e };
      }
    }),
  );

  // A key missing a scope, a rejected sign-in or an inactive identity fails
  // every provider the same way. One reply that says so beats a menu of identical "unavailable" rows.
  const userLevel = urlResults.find(
    (r) =>
      r.url === null &&
      (missingKeyScopes(r.error) !== undefined ||
        isUserTokenRejected(r.error) ||
        identityTerminal(r.error) !== undefined),
  );
  if (userLevel) return failureReply(log, "build connect links", userLevel.error);
  for (const { id, url, error } of urlResults) {
    if (url === null) {
      log.warn(
        `[alter] /alter connect menu could not build a ${id} link: ` +
          (error instanceof Error ? `${error.name}: ${error.message}` : String(error)) +
          hintSuffix(error),
      );
    }
  }

  const lines: string[] = [];
  if (connected.length > 0) {
    lines.push("Your connections:");
    for (const id of connected) lines.push(`  ✓ ${providerDisplayName(id)}`);
    lines.push("");
  }
  if (urlResults.length > 0) {
    lines.push("Connect more (click any link):");
    for (const { id, url } of urlResults) {
      if (url) lines.push(`  • ${providerDisplayName(id)} — ${url}`);
      else lines.push(`  • ${providerDisplayName(id)} — (unavailable right now; try /alter connect ${id})`);
    }
  }
  if (lines.length === 0) {
    lines.push("No providers configured.");
  }
  return reply(lines.join("\n"));
}

async function doConnections(
  deps: CommandsDeps,
  log: CommandLog,
  ch: ChannelCtx,
  args: string[],
): Promise<PluginCommandResult> {
  const link = deps.identities.get(ch.channelKind, ch.channelUserId);
  if (!link) return reply("You're not signed in. Use /alter login first.", true);

  if (args[0] === "revoke" && args[1]) {
    const grantId = args[1];
    try {
      // The revoke handle is a USER base grant id from the list below.
      // `app.revokeGrant` revokes the whole base grant and CASCADE-revokes the
      // agent delegations hanging off it — so this is also how the agent loses
      // access. (A delegation on its own can only be revoked by its parent base
      // grant id, which the SDK grant item does not surface, so base-grant
      // revocation is the management primitive.) We look up the grant first so
      // we can evict the delegation cache for the right provider on success.
      const grants = await currentUserJwt.run(link.jwt, async () =>
        listAllGrants(deps.app),
      );
      const target = grants.find(
        (g) => g.grantKind === "oauth" && g.grantId === grantId,
      );
      const res = await currentUserJwt.run(link.jwt, async () =>
        deps.app.revokeGrant(grantId, {
          reason: "user requested via /alter connections revoke",
        }),
      );
      // Evict the delegation cache by PROVIDER (the cache stores agent
      // delegation ids, not base grant ids, so a grantId match would never
      // hit). Revoking the base grant cascade-killed the delegation, so the
      // cached id is now dead. We do NOT echo res.message back to the user —
      // it can carry SDK/backend internal text meant for operator logs.
      if (target && target.grantKind === "oauth") {
        deps.grants.delete(link.appUserId, target.providerId);
      }
      return reply(
        `Revoked grant ${grantId} (success: ${res.success}).`,
        !res.success,
      );
    } catch (e) {
      return failureReply(log, `revoke ${grantId}`, e);
    }
  }

  try {
    const grants = await currentUserJwt.run(link.jwt, async () =>
      listAllGrants(deps.app),
    );
    if (grants.length === 0) {
      return reply("No connected providers. Try /alter connect <provider>.");
    }
    const lines = grants.map((g) => {
      if (g.grantKind === "oauth") {
        return `• ${g.providerId} — ${g.grantId} (${g.status})`;
      }
      return `• ${g.managedSecretSlug} — ${g.grantId} (${g.status}, managed-secret)`;
    });
    return reply(["Your connections:", ...lines].join("\n"));
  } catch (e) {
    return failureReply(log, "list connections", e);
  }
}

function doWallet(deps: CommandsDeps): PluginCommandResult {
  return reply(
    `Open your wallet: ${deps.cfg.walletBaseUrl}\n` +
    `(Sign in with the same IdP account you used for /alter login. ` +
    `The wallet enforces per-user scoping itself — you'll see only your own activity.)`,
  );
}

async function doStatus(
  deps: CommandsDeps,
  ch: ChannelCtx,
  args: string[],
): Promise<PluginCommandResult> {
  // Resolve identity FIRST — the lock is keyed on (session, app_user), and in a
  // shared Slack group DM the session alone is every participant's. Reading or
  // clearing by session would let one participant see another's wallet URL, or
  // clear their lock and let a duplicate approval be minted.
  const link = deps.identities.get(ch.channelKind, ch.channelUserId);
  if (args[0] === "clear") {
    if (!link) {
      // No identity → no lock of your own to clear. Refusing is not pedantry:
      // clearing by session is exactly how one user could unlock another's gate.
      return reply("You're not signed in, so you have no pending-approval lock to clear.");
    }
    deps.approvalLock.clear(ch.sessionId, link.appUserId);
    return reply("Pending-approval lock cleared.");
  }
  let lock = link ? deps.approvalLock.activeFor(ch.sessionId, link.appUserId) : undefined;
  let polled: ApprovalStatus | undefined;
  if (lock && link) {
    // Reconcile against the backend so we never report an already-resolved
    // approval (approved+executed server-side, denied, expired, failed) as
    // "pending" — the stale-lock replay bug on the status surface. Fail SAFE on
    // a poll error: keep whatever the local lock says (the TTL still backstops).
    try {
      const status = await deps.agent.getApprovalStatus(lock.approvalId);
      if (status.isTerminal) {
        deps.approvalLock.clear(ch.sessionId, link.appUserId);
        lock = undefined;
      } else {
        polled = status;
      }
    } catch {
      // Keep the local lock — never clear one we can't confirm resolved.
    }
  }
  let pendingLine = "Pending approval: none";
  if (lock) {
    const total = lock.gates?.length ?? 1;
    if (total <= 1) {
      pendingLine = `Pending approval: ${lock.toolName} → ${lock.approvalUrl}`;
    } else {
      // Multi-party: list the approvers who haven't decided yet, not just the
      // executor gate's link.
      const outstanding = outstandingGates(lock, polled);
      pendingLine =
        `Pending approval: ${lock.toolName} (${outstanding.length} of ${total} ` +
        `approvals still need a decision):\n${numberedGateLinks(outstanding)}`;
    }
  }
  const lines = [`Linked: ${link ? "yes" : "no"}`, pendingLine];
  if (lock) lines.push("Type `/alter status clear` to clear the lock if it's stale.");
  return reply(lines.join("\n"));
}

export function registerCommands(api: OpenClawPluginApi, deps: CommandsDeps): void {
  api.registerCommand({
    name: "alter",
    description:
      "Manage your Alter Vault link, OAuth connections, wallet, and approval state.",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx: PluginCommandContext) => {
      const ch = requireChannel(ctx);
      if (!ch) return noChannelMsg();

      const tokens = (ctx.args ?? "").trim().split(/\s+/).filter(Boolean);
      const sub = tokens[0]?.toLowerCase() ?? "";
      const rest = tokens.slice(1);

      switch (sub) {
        case "":
        case "help":
        case "-h":
        case "--help":
          return reply(HELP_TEXT);
        case "login":
          return doLogin(deps, api.logger, ch);
        case "connect":
          return doConnect(deps, api.logger, ch, rest[0] ?? "");
        case "connections":
          return doConnections(deps, api.logger, ch, rest);
        case "wallet":
          return doWallet(deps);
        case "status":
          return doStatus(deps, ch, rest);
        default:
          return reply(`Unknown subcommand: ${sub}\n\n${HELP_TEXT}`, true);
      }
    },
  });
}
