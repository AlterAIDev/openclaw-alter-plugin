import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import type { Agent, ApprovalStatus } from "@alter-ai/alter-sdk";
import {
  AlterValueError,
  ApprovalResult,
  BackendError,
  CredentialRevokedError,
  GrantDeletedError,
  GrantExpiredError,
  GrantNotFoundError,
  GrantRevokedError,
  NoDelegatedGrantError,
  PendingApproval,
  PolicyViolationError,
  ProviderUnauthorizedError,
  QuotaExceededError,
  RateLimitError,
  ReAuthRequiredError,
  ScopeReauthRequiredError,
  StepUpRequiredError,
  TokenRefreshInProgressError,
} from "@alter-ai/alter-sdk";
import {
  hintSuffix,
  identityTerminal,
  isUserTokenRejected,
  KEY_SCOPE_MESSAGE,
  keyScopeLog,
  missingKeyScopes,
} from "../alter-client.js";
import type { IdentityStore } from "../identity/store.js";
import type { GrantsStore } from "../grants/store.js";
import { listAllAgentGrants, selectActiveAgentOAuthGrant } from "../grants/grant-query.js";
import { hashIdpSub } from "../identity/sub-hash.js";
import {
  numberedGateLinks,
  outstandingGates,
  type PendingApprovalLock,
} from "../pending-approval-lock.js";
import type { RateLimitStore } from "../rate-limit/store.js";
import { capToolResultJson } from "../tool-result-cap.js";
import { signInPrompt } from "../identity/sign-in-prompt.js";
import type { ProviderId } from "./providers.js";
import { providerDisplayName } from "./providers.js";

/**
 * Per-(appUserId, provider) singleflight for the cache-miss `listGrants`
 * probe in `execute()`. Without this, N concurrent tool calls from the same
 * user immediately after a reconnect each fire their own `listGrants` + DB
 * upsert. Coalescing into one in-flight promise removes the stampede.
 *
 * Process-local (Node single-threaded). The Map is module-level so different
 * tools share the gate.
 */
const listGrantsInFlight = new Map<string, Promise<string | undefined>>();

function singleflightListGrants(
  key: string,
  fn: () => Promise<string | undefined>,
): Promise<string | undefined> {
  const existing = listGrantsInFlight.get(key);
  if (existing) return existing;
  const fresh = fn().finally(() => listGrantsInFlight.delete(key));
  listGrantsInFlight.set(key, fresh);
  return fresh;
}

export interface AlterToolDeps {
  agent: Agent;
  identities: IdentityStore;
  grants: GrantsStore;
  approvalLock: PendingApprovalLock;
  rateLimit: RateLimitStore;
  /**
   * Per-deployment salt for {@link hashIdpSub}. Log sites here key a user by
   * `hashIdpSub(channelHashSalt, link.idpSub)` rather than echoing the raw
   * `appUserId` (= `idp:<sub>`) into shipped logs.
   */
  channelHashSalt: string;
  /**
   * Start (or reuse) an Alter auth session for the given channel-user. Returns
   * the URL to send the user. Backed by App.createAuthSession + the AuthPoller.
   */
  startLogin: (
    channelKind: string,
    channelUserId: string,
    sessionId: string,
  ) => Promise<string>;
  buildConnectUrl: (
    channelKind: string,
    channelUserId: string,
    appUserId: string,
    provider: string,
    sessionId: string,
  ) => Promise<string>;
}

export interface AlterToolSpec<TParams extends TSchema> {
  name: string;
  description: string;
  parameters: TParams;
  /** Must be one of the canonical ids registered in `providers.ts`. */
  provider: ProviderId;
  /**
   * Set to `true` for any tool whose effect is user-visible and
   * irreversible — sending an email, posting a Slack message, creating a
   * GitHub issue, cancelling a Calendly event.
   *
   * Server-side Alter policy (`requires_approval` on the grant) is the
   * source of truth for HITL gating. The SDK does not expose the policy
   * field on `OAuthGrantItem`, so the plugin cannot pre-check it. What
   * `hitl: true` adds:
   *   1. A post-call invariant check: if `proxyRequest` returns an
   *      `ApprovalResult` (executed without approval) for an HITL spec,
   *      log ERROR-level and drop the grant cache so the next call
   *      forces a fresh probe — paired with an operator policy fix,
   *      this restores HITL gating on subsequent invocations.
   *   2. A clear operator signal in logs/audit that this tool was
   *      designed to require approval.
   *
   * Read-only tools (search, list, get) should leave this `false`.
   */
  hitl?: boolean;
  toProxyArgs: (params: Record<string, unknown>) => Promise<{
    method: string;
    url: string;
    jsonBody?: unknown;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
  }>;
  formatResult: (result: ApprovalResult) => unknown;
}

interface AgentToolResultLike {
  isError: boolean;
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}

function errResult(text: string): AgentToolResultLike {
  return { isError: true, content: [{ type: "text", text }] };
}

function okResult(text: string, details?: unknown): AgentToolResultLike {
  return { isError: false, content: [{ type: "text", text }], details };
}

/**
 * Short reason tag when an SDK error means "the cached delegation is dead,
 * reconnect", else undefined. Classified by error class alone: the SDK turns
 * every grant-terminal code the backend sends into a typed error, so there is
 * no string-code or bare-404/410 fallback. A bare 404 is not proof the grant is
 * gone anyway: `AgentNotFoundError` (404 `caller_agent_unresolved`) is a key
 * misconfiguration that a reconnect can't fix.
 *
 * Keep tags short. The reconnect link does the work; a long reason nudges the
 * model into explaining instead of handing over the link. Subclasses are tested
 * before `ReAuthRequiredError`, their common parent.
 */
function reauthTag(e: unknown): string | undefined {
  if (e instanceof GrantExpiredError) return "expired";
  if (e instanceof CredentialRevokedError) return "revoked at provider";
  if (e instanceof GrantDeletedError) return "disconnected in wallet";
  if (e instanceof GrantRevokedError) return "revoked";
  if (e instanceof NoDelegatedGrantError) return "delegation removed in wallet";
  if (e instanceof ScopeReauthRequiredError) {
    const missing = e.missingScopes;
    return missing && missing.length > 0
      ? `missing scopes: ${missing.join(", ")}`
      : "missing required scopes";
  }
  // Includes AgentDelegationMissingError, the agent-path subclass.
  if (e instanceof GrantNotFoundError) return "no longer linked";
  // Never thrown by proxyRequest, which returns a provider-side 401 as an
  // ApprovalResult (status_code=401) that `formatResult` relays. Only request()
  // throws it; kept so this ladder covers the SDK's whole reauth surface.
  if (e instanceof ProviderUnauthorizedError) return "revoked at provider";
  // Any future subclass. A plain ReAuthRequiredError is a rejected sign-in
  // token, which callers must catch first with `isUserTokenRejected`.
  if (e instanceof ReAuthRequiredError) return "connection no longer valid";
  return undefined;
}

/**
 * The replay for a still-pending locked approval. A single gate keeps the
 * one-link wording. A multi-party group lists only the gates still waiting on a
 * decision, so an approver who already approved isn't sent back to their own
 * link while the others' links scroll away.
 */
function pendingApprovalText(
  toolName: string,
  outstanding: readonly { approvalUrl: string }[],
  totalGates: number,
): string {
  const [only] = outstanding;
  if (totalGates <= 1 && only && outstanding.length === 1) {
    return (
      `You have a pending approval for ${toolName}: ${only.approvalUrl}\n` +
      "Approve or deny it in the wallet, then ask again."
    );
  }
  return (
    `You have a pending approval for ${toolName}. ` +
    `${outstanding.length} of ${totalGates} approvals still need a decision ` +
    `(each link may be for a different approver; all must approve):\n` +
    numberedGateLinks(outstanding) +
    "\nAsk again once they're done."
  );
}

/** Rough human wait for a retry-after in seconds ("45s", "20 minutes", "3 days"). */
function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

export function registerAlterTool<TParams extends TSchema>(
  api: OpenClawPluginApi,
  deps: AlterToolDeps,
  spec: AlterToolSpec<TParams>,
): void {
  const factory: OpenClawPluginToolFactory = (ctx: OpenClawPluginToolContext) => {
    const sessionId = ctx.sessionId;
    const channelKind = ctx.messageChannel;
    const channelUserId = ctx.requesterSenderId;

    const tool: AnyAgentTool = {
      name: spec.name,
      label: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      ownerOnly: false,
      async execute(_toolCallId, params) {
        if (!sessionId || !channelKind || !channelUserId) {
          return errResult(
            `${spec.name} requires a channel-attached chat session. ` +
              "(No sessionId/messageChannel/requesterSenderId in tool context — most likely the agent " +
              "is running outside a channel turn, e.g. a CLI/scheduled run.)",
          );
        }

        // Start a sign-in and hand back its link (see `signInPrompt`).
        const freshSignIn = async (lead: string, cantStart: string): Promise<AgentToolResultLike> => {
          const prompt = await signInPrompt({
            startLogin: () => deps.startLogin(channelKind, channelUserId, sessionId),
            lead,
            cantStart,
            warn: (m) => api.logger.warn(`[alter] ${spec.name} ${m}`),
            error: (m) => api.logger.error(`[alter] ${spec.name} ${m}`),
          });
          return prompt.isError ? errResult(prompt.text) : okResult(prompt.text);
        };

        // One of this deployment's Alter keys is missing a scope the call
        // needs. Returns the result to hand back, or undefined if `e` is some
        // other failure. Error level: it breaks this call for every user until
        // the operator fixes the key.
        const keyScopeFailure = (e: unknown, doing: string): AgentToolResultLike | undefined => {
          const scopes = missingKeyScopes(e);
          if (!scopes) return undefined;
          api.logger.error(`[alter] ${spec.name} ${keyScopeLog(doing, scopes)}`);
          return errResult(
            `${KEY_SCOPE_MESSAGE} Tell the user this plainly; do NOT suggest reconnecting or retrying.`,
          );
        };

        const link = deps.identities.get(channelKind, channelUserId);
        if (!link) {
          return freshSignIn(
            "You need to sign in once before I can help.",
            "You need to sign in, but I couldn't start the sign-in flow",
          );
        }
        if (link.jwtExpiresAt < Date.now()) {
          return freshSignIn(
            "Your sign-in expired.",
            "Your sign-in expired and I couldn't start a new one",
          );
        }

        // Alter rejected the stored JWT even though its local `exp` is fine.
        // Reached from every call below that presents the user's token: the
        // grant probe, the connect-session mint, and the proxied call itself.
        const signInAfterRejection = (e: unknown): Promise<AgentToolResultLike> => {
          // Warn, not info: rejections that repeat straight after a fresh
          // sign-in mean a new link won't help. Either the IdP's iss/aud don't
          // match the Alter app config, or Alter can't reach the IdP's JWKS /
          // OIDC discovery (see `isUserTokenRejected`). The backend's reason in
          // this line says which. It is never the token.
          api.logger.warn(
            `[alter] ${spec.name} sign-in token rejected by Alter for ` +
              `app_user_h=${hashIdpSub(deps.channelHashSalt, link.idpSub)} provider=${spec.provider}: ` +
              (e instanceof Error ? e.message : String(e)),
          );
          return freshSignIn(
            "Alter rejected your sign-in, so you need to sign in again.",
            "Alter rejected your sign-in and I couldn't start a new one",
          );
        };

        // GATE ORDER IS SECURITY-CRITICAL: identity BEFORE the approval lock.
        //
        // The lock is keyed on (sessionId, appUserId), so we cannot consult it
        // until we know who is asking. Checking it first would serve a lock found
        // by session alone to whoever called, including a DIFFERENT participant
        // of a shared Slack group DM, and including someone who had never signed
        // in. That hands them another user's wallet URL and tool name.
        // Do not reorder these two blocks.
        const pending = deps.approvalLock.activeFor(sessionId, link.appUserId);
        if (pending) {
          // Don't blindly replay the stored URL — the approval it points at may
          // already be resolved. Alter executes an APPROVED request server-side
          // and never re-invokes this plugin, so the lock has no in-band signal
          // that the approval finished; polling its status is the only reliable
          // one. Without this, an already-executed approval's URL gets re-served
          // for up to the lock's 1-hour TTL (the stale-lock replay bug).
          let status: ApprovalStatus;
          try {
            status = await deps.agent.getApprovalStatus(pending.approvalId);
          } catch (e) {
            // Couldn't confirm the approval's state (network, scoping, or the
            // row was retention-purged). Fail SAFE: keep the lock and replay the
            // URL exactly as before — never clear a lock we can't prove resolved.
            // The 1-hour TTL and `/alter status clear` stay as the backstops.
            api.logger.warn(
              `[alter] ${spec.name} approval-status poll failed for ` +
                `${pending.approvalId} on session ${sessionId}: ` +
                (e instanceof Error ? `${e.name}: ${e.message}` : String(e)) +
                hintSuffix(e),
            );
            return errResult(
              pendingApprovalText(pending.toolName, outstandingGates(pending), pending.gates?.length ?? 1) +
                " (Type /alter status to clear if the wallet shows it as resolved.)",
            );
          }
          if (!status.isTerminal) {
            // Genuinely still pending / approved / executing — keep gating so we
            // don't queue a second write while the first is mid-flight.
            if (status.status === "approved" || status.status === "executing") {
              // Every gate has approved and Alter is running it. Pointing the
              // user back at the wallet would read as "you still need to approve".
              return errResult(
                `Your earlier ${pending.toolName} was approved and is running now. ` +
                  "Ask again in a moment for the outcome.",
              );
            }
            return errResult(
              pendingApprovalText(
                pending.toolName,
                outstandingGates(pending, status),
                pending.gates?.length ?? 1,
              ),
            );
          }
          // Terminal → the lock is stale. Clear it and report the outcome. We do
          // NOT fall through to re-run the tool: an `executed` approval already
          // ran server-side, so re-executing here would double-send a
          // non-idempotent write. The user's NEXT call finds no lock and proceeds
          // normally (creating a fresh approval).
          deps.approvalLock.clear(sessionId, link.appUserId);
          api.logger.info(
            `[alter] ${spec.name} cleared resolved approval lock ${pending.approvalId} ` +
              `for session ${sessionId} (status=${status.status})`,
          );
          if (status.status === "executed") {
            return okResult(
              `Your earlier ${pending.toolName} was approved and already completed. ` +
                "Ask again if you need to do it once more.",
            );
          }
          const outcome =
            status.status === "denied"
              ? "was denied"
              : status.status === "expired"
                ? "expired before you decided"
                : `failed during execution${status.executionError ? `: ${status.executionError}` : ""}`;
          return errResult(
            `Your earlier ${pending.toolName} approval ${outcome}. Ask again if you'd like.`,
          );
        }

        // Bind this session to the resolved app_user so the llm_output hook
        // can attribute LLM usage to the right user, AND check the per-day cap
        // BEFORE we let the call proceed.
        deps.rateLimit.bindSession(sessionId, link.appUserId);
        if (deps.rateLimit.isOverQuota(link.appUserId)) {
          return errResult(
            "You've reached today's usage cap. Try again tomorrow, or ask an operator " +
              "to raise rateLimitInputTokensPerDay / rateLimitOutputTokensPerDay.",
          );
        }

        let grantId = deps.grants.get(link.appUserId, spec.provider);
        if (!grantId) {
          // Cache miss — probe Alter for an existing grant before triggering
          // a new connect flow. This is what makes the OAuth callback to our
          // HTTP endpoint optional: if the user already connected this provider
          // (visible in Alter Vault), we discover and cache the grant_id here
          // without needing the redirect to hit /alter/connect/cb.
          //
          // Singleflight so N concurrent tool calls from the same user
          // coalesce into one upstream `listGrants` + one DB upsert.
          const sfKey = `${link.appUserId}\x00${spec.provider}`;
          try {
            const probedGrantId = await singleflightListGrants(sfKey, async () => {
              // Probe the AGENT's delegated view (`agent.listGrants`), NOT the
              // App/user view. The rows here are exactly THIS agent's usable
              // delegations for this user, so the grant_id we cache is one
              // `agent.proxyRequest({ grantId })` can actually resolve. Handing
              // the proxy a user-principal grant id the agent was never
              // delegated is what produced the opaque 404 `grant_not_found`
              // reconnect-loop. `endUserToken` scopes the delegated edges to
              // this user; the agent is the principal, so (unlike the App path)
              // there is no `currentUserJwt.run(...)` wrapper.
              //
              // Paginate to completion (same helper the connect callback uses):
              // `listGrants` ordering isn't guaranteed, so a user with many
              // historical delegations for this provider could otherwise push
              // the active one off a single unordered page and hide it.
              const grantRows = await listAllAgentGrants(deps.agent, {
                providerId: spec.provider,
                endUserToken: link.jwt,
              });
              // Pre-filter visibility: what did Alter actually return for this
              // agent + user + provider? Tells us whether the probe is empty
              // because the agent holds no delegation for this user, or because
              // the plugin's filter (oauth + provider + active) is dropping
              // rows. Compact one-line summary to keep log volume bounded — N
              // grants per call.
              const summary = grantRows
                .map((g) => {
                  // Discriminated union: oauth has providerId, managed-
                  // secret has managedSecretSlug. Print whichever applies
                  // so we can tell the two shapes apart at a glance.
                  const what =
                    g.grantKind === "oauth"
                      ? `provider=${g.providerId}`
                      : `secret=${g.managedSecretSlug}`;
                  return (
                    `kind=${g.grantKind} ` +
                    `${what} ` +
                    `principal=${g.principalType} ` +
                    `status=${g.status} ` +
                    `createdAt=${g.createdAt ?? "-"}`
                  );
                })
                .join(" | ");
              api.logger.info(
                `[alter] ${spec.name} agent-delegation probe response for ` +
                  `app_user_h=${hashIdpSub(deps.channelHashSalt, link.idpSub)} provider=${spec.provider}: ` +
                  `returned=${grantRows.length}` +
                  (summary ? ` rows=[${summary}]` : " rows=[]"),
              );
              // Newest ACTIVE agent delegation. The active filter is what makes
              // wallet-revoke self-correct: a delegation the user removed in the
              // wallet comes back here as status="revoked"/"expired", so it's
              // ignored and the caller falls through to the connect prompt
              // instead of caching a dead grant_id.
              return selectActiveAgentOAuthGrant(grantRows, {
                provider: spec.provider,
              })?.grantId;
            });
            if (probedGrantId) {
              deps.grants.upsert(link.appUserId, spec.provider, probedGrantId);
              grantId = probedGrantId;
            }
          } catch (e) {
            if (isUserTokenRejected(e)) {
              return signInAfterRejection(e);
            }
            // The agent key can't list grants. Falling through would offer a
            // connect link, and the user would connect, come back, and be
            // offered it again forever: the probe can never see the grant.
            const scopeFailure = keyScopeFailure(e, "look up the user's connection");
            if (scopeFailure) return scopeFailure;
            // listGrants failed — fall through to the "not connected" path.
            // Log so operators can distinguish "Alter said no grants" from
            // "the probe blew up" (network, 401, malformed response, etc.).
            api.logger.warn(
              `[alter] ${spec.name} listGrants probe failed for ` +
                `app_user_h=${hashIdpSub(deps.channelHashSalt, link.idpSub)} provider=${spec.provider}: ` +
                (e instanceof Error ? `${e.name}: ${e.message}` : String(e)) +
                hintSuffix(e),
            );
          }
        }
        if (!grantId) {
          let url: string;
          try {
            // Mints the connect session under the user's JWT, so a rejected
            // token surfaces here when the probe didn't already catch it.
            url = await deps.buildConnectUrl(
              channelKind,
              channelUserId,
              link.appUserId,
              spec.provider,
              sessionId,
            );
          } catch (e) {
            if (isUserTokenRejected(e)) {
              return signInAfterRejection(e);
            }
            const scopeFailure = keyScopeFailure(e, "create a connect link");
            if (scopeFailure) return scopeFailure;
            throw e;
          }
          // Successful result (not isError) — the connect link is the actionable
          // next step for the model to relay verbatim, not a tool failure.
          return okResult(
            `You haven't connected ${providerDisplayName(spec.provider)} yet. ` +
              `Click here: ${url}\n` +
              `(If the account is already connected to Alter you'll see a quick ` +
              `confirmation screen instead of a full sign-in — that's expected; ` +
              `use "Use a different account" there to switch accounts.)\n` +
              `After connecting, ask me again.`,
          );
        }

        // Runtime validation at the LLM→tool boundary. TypeScript's compile-
        // time guarantees don't apply: `params` is whatever the LLM emitted.
        // TypeBox schemas on each spec carry constraints (`pattern: NO_CRLF`,
        // `maxLength`, `minLength`, `Integer({minimum, maximum})`) that are
        // decorative unless Value.Check is called here. Reject malformed
        // input with a clear error rather than relying on the upstream API
        // to 4xx — and never call the schema-less `toProxyArgs` with junk.
        const paramsRecord = asRecord(params);
        if (!Value.Check(spec.parameters, paramsRecord)) {
          // Value.Errors returns an array (not an iterator); take the first
          // for the user-facing detail message. The full list is logged
          // below for operator triage.
          const errs = Value.Errors(spec.parameters, paramsRecord);
          const firstError = errs[0];
          const detail = firstError
            ? `${firstError.instancePath || "<root>"}: ${firstError.message}`
            : "(no detail)";
          return errResult(
            `Invalid arguments to ${spec.name}: ${detail}. ` +
              "Re-issue the tool call with arguments that match the schema.",
          );
        }
        const proxy = await spec.toProxyArgs(paramsRecord);
        try {
          // `userToken` is passed explicitly (not via the ambient
          // `currentUserJwt.run(...)` scope): the SDK's identity propagation
          // makes proxyRequest consult the constructor `userTokenGetter`,
          // which is fail-closed and THROWS outside an ALS scope. The
          // per-call override beats the getter, pins WHICH user's delegation
          // this call runs under (this agent serves many Slack users), and
          // matches the probe's explicit `endUserToken` pattern above.
          const result = await deps.agent.proxyRequest({
            method: proxy.method,
            url: proxy.url,
            grantId,
            userToken: link.jwt,
            // Remap the INTERNAL toProxyArgs contract (`jsonBody`/`headers`,
            // stable across the 20+ tool specs and the AlterToolSpec type) to
            // the SDK's proxyRequest wire names (`json`/`extraHeaders`). This
            // MUST stay a keyed remap, not a spread of `proxy`: an object-spread
            // hides `jsonBody`/`headers` from tsc's excess-property check, so
            // they compile but the SDK never reads them — dropping the request
            // body and Content-Type at runtime (every write tool → provider 400).
            ...(proxy.jsonBody !== undefined ? { json: proxy.jsonBody } : {}),
            ...(proxy.headers ? { extraHeaders: proxy.headers } : {}),
            ...(proxy.queryParams ? { queryParams: proxy.queryParams } : {}),
            reason: spec.name,
          });

          if (result instanceof PendingApproval) {
            // Log every HITL creation. Without this line the gateway has NO
            // record of its single most sensitive event — an irreversible write
            // being staged — because the success path logs nothing, and an
            // operator reconstructing what happened would otherwise have only
            // the chat transcript to go on. Alter Vault has its own audit; this
            // is the gateway-side correlate. Never log the approval URL: it is the
            // actionable secret, and logs are shipped.
            api.logger.info(
              `[alter] ${spec.name} HITL approval created ${result.approvalId} for ` +
                `app_user_h=${hashIdpSub(deps.channelHashSalt, link.idpSub)} ` +
                `provider=${spec.provider} session=${sessionId} ` +
                `group=${result.approvalGroupId} gates=${result.gates.length} ` +
                `expiresAt=${result.expiresAt.toISOString()}`,
            );
            const rejected = deps.approvalLock.set(sessionId, link.appUserId, {
              approvalId: result.approvalId,
              approvalUrl: result.approvalUrl,
              toolName: spec.name,
              createdAt: Date.now(),
              // Pin the lock's idle-purge horizon to the approval's real
              // (operator-configurable) window so it lives exactly as long as
              // the approval it guards — not a hardcoded 1-hour guess.
              expiresAtMs: result.expiresAt.getTime(),
              // Every gate's link, so a later replay can list the approvers who
              // haven't decided yet instead of only the executor's link.
              ...(result.gates.length > 1
                ? {
                    gates: result.gates.map((g) => ({
                      approvalId: g.approvalId,
                      approvalUrl: g.approvalUrl,
                    })),
                  }
                : {}),
            });
            if (rejected) {
              // We landed in a race where a different approval is already
              // pending for THIS USER in this session. The proxyRequest already
              // created a row in Alter — we surface the new URL so the user can
              // decide which approval to act on first.
              api.logger.warn(
                `[alter] ${spec.name} created approval ${result.approvalId} but another ` +
                  `pending approval is already locked for this user on session ${sessionId}; ` +
                  `surfacing both URLs to user.`,
              );
            }
            // N-of-N multi-party approval: a request that trips several distinct
            // approver sets comes back with one gate per set, and Alter executes
            // only once EVERY gate is approved. `approvalUrl` is just the
            // executor gate's link, so relaying it alone would strand the other
            // approvers (email delivery is optional and often unconfigured) and
            // the group would expire. The lock keeps the executor id: polling it
            // returns the group's derived status.
            if (result.gates.length > 1) {
              return errResult(
                `This needs ${result.gates.length} separate approvals before it runs ` +
                  `(each link may be for a different approver; all must approve):\n` +
                  numberedGateLinks(result.gates) +
                  `\nReply 'approved' once every approval is done.`,
              );
            }
            return errResult(
              `Awaiting your approval at ${result.approvalUrl}. ` +
                `Reply 'approved' once you've approved in the wallet.`,
            );
          }

          if (spec.hitl) {
            // HITL invariant violation. The spec is marked `hitl: true`
            // because the action is user-visible and irreversible
            // (gmail send, slack post, etc.) — every such call MUST go
            // through wallet approval. Reaching here means the Alter
            // server-side policy on this grant is missing
            // `requires_approval` and the action just executed silently.
            //
            // The current SDK doesn't expose `requires_approval` on
            // `OAuthGrantItem`, so we cannot pre-check; this post-check
            // is the strongest available signal. We:
            //   1. Log ERROR at operator-visible severity so this lands
            //      in Sentry/Loki for incident response.
            //   2. Drop the local grant cache so the next call forces
            //      a fresh `listGrants` probe (which the operator can
            //      pair with a policy fix to restore HITL gating).
            api.logger.error(
              `[alter] ${spec.name} HITL VIOLATION: grant ${grantId} executed without approval. ` +
                `The Alter policy on this grant is missing requires_approval — operator must ` +
                `reconfigure the policy in the Alter portal before ${spec.name} is invoked again.`,
            );
            deps.grants.delete(link.appUserId, spec.provider);
          }

          return okResult(
            capToolResultJson(spec.formatResult(result), { maxBytes: 8192 }),
          );
        } catch (e) {
          // Every branch below matches on SDK error classes. The backend's code
          // and HTTP status are carried along for operator logs only.
          const backendCode =
            e instanceof BackendError && typeof e.details.error === "string"
              ? e.details.error
              : undefined;
          const backendStatus = e instanceof BackendError ? e.statusCode : undefined;

          // Before the reauth ladder: this is a plain ReAuthRequiredError, which
          // the ladder would read as a dead grant, drop the cache, and answer
          // with a reconnect link that can't work under the rejected token.
          if (isUserTokenRejected(e)) {
            return signInAfterRejection(e);
          }

          // A BackendError (403), so without this it would reach the generic
          // branch below and log no scope names.
          const scopeFailure = keyScopeFailure(e, `call ${spec.provider}`);
          if (scopeFailure) return scopeFailure;

          // Grant terminal: the cached grant_id is dead. Drop it, build a fresh
          // connect URL, and say why, instead of looping on "retry".
          const tag = reauthTag(e);
          if (tag !== undefined) {
            deps.grants.delete(link.appUserId, spec.provider);
            const provider = providerDisplayName(spec.provider);
            let urlLine: string;
            try {
              const url = await deps.buildConnectUrl(
                channelKind,
                channelUserId,
                link.appUserId,
                spec.provider,
                sessionId,
              );
              urlLine = `Reconnect ${provider}: ${url}`;
            } catch {
              urlLine = `Reconnect with /alter connect ${spec.provider}.`;
            }
            const reauthErrName = e instanceof Error ? e.constructor.name : "UnknownError";
            const reauthErrMsg = e instanceof Error ? e.message : String(e);
            api.logger.info(
              `[alter] ${spec.name} reauth required for ` +
                `app_user_h=${hashIdpSub(deps.channelHashSalt, link.idpSub)} provider=${spec.provider}: ` +
                `${reauthErrName}: ${reauthErrMsg} (code=${backendCode ?? "none"} status=${backendStatus ?? "?"})`,
            );
            return errResult(
              `${urlLine}\n(${provider} ${tag}. Share the link above with the user and stop — do NOT explain or workshop. A quick "already connected" confirmation screen on the link is expected, not an error. After they reconnect, ask the user to retry.)`,
            );
          }
          // Before PolicyViolationError: StepUpRequiredError is a subclass. A
          // content_match step-up rule wants a fresher end-user session than this
          // link's JWT (the backend measures the user token's `iat`), and a new
          // sign-in mints exactly that. So this is the expired-link flow, not a
          // dead-end policy block. The 403 comes from the policy gate, so nothing
          // executed and the user's retry is safe.
          if (e instanceof StepUpRequiredError) {
            api.logger.info(
              `[alter] ${spec.name} step-up sign-in required for ` +
                `app_user_h=${hashIdpSub(deps.channelHashSalt, link.idpSub)} provider=${spec.provider} ` +
                `(maxSessionAgeSeconds=${e.maxSessionAgeSeconds ?? "?"})`,
            );
            return freshSignIn(
              "This action needs a fresh sign-in (your Alter policy requires a recent login).",
              "This action needs a fresh sign-in and I couldn't start one",
            );
          }
          // Identity-level terminal (a 403 the SDK surfaces as a plain
          // PolicyViolationError), so it must precede the generic policy branch.
          // Reconnecting or retrying can't fix it, only an administrator can, so
          // say so and stop the agent from looping.
          const terminal = identityTerminal(e);
          if (terminal !== undefined) {
            const provider = providerDisplayName(spec.provider);
            api.logger.warn(
              `[alter] ${spec.name} refused: identity ${terminal} for ` +
                `app_user_h=${hashIdpSub(deps.channelHashSalt, link.idpSub)} provider=${spec.provider}`,
            );
            return errResult(
              `Your Alter identity has been ${terminal}, ` +
                `so ${provider} can't be accessed. Reconnecting won't help — an administrator must ` +
                `${terminal === "deprovisioned" ? "re-provision" : "reactivate"} the account. ` +
                `Tell the user this plainly; do NOT suggest reconnecting or retrying.`,
            );
          }
          if (e instanceof PolicyViolationError) {
            return errResult(`Action blocked by policy: ${e.message}`);
          }
          if (e instanceof AlterValueError) {
            return errResult(`Invalid request to ${spec.provider}: ${e.message}`);
          }
          // Typed 429s. Both are BackendErrors, so without this branch they fall
          // into the generic 4xx case below and the model is told "not
          // retryable", which is wrong for both. RateLimitError is Alter's own
          // limiter (per key/org/IP): clears in seconds. QuotaExceededError is a
          // policy quota on the grant: its window can be a whole month, so the
          // wait matters more than the retry.
          if (e instanceof RateLimitError || e instanceof QuotaExceededError) {
            const provider = providerDisplayName(spec.provider);
            api.logger.warn(
              `[alter] ${spec.name} ${e.name} calling ${spec.provider}: ${e.message} ` +
                `(retryAfter=${e.retryAfter ?? "?"}s` +
                (e instanceof RateLimitError
                  ? ` scope=${e.scope ?? "?"} limit=${e.limit ?? "?"}/${e.windowSeconds ?? "?"}s`
                  : "") +
                ")",
            );
            if (e instanceof QuotaExceededError) {
              return errResult(
                `${provider} has used up the request quota your Alter policy allows` +
                  (e.retryAfter !== undefined ? `; it resets in about ${formatWait(e.retryAfter)}` : "") +
                  ". Relay this to the user plainly; do not retry before then.",
              );
            }
            return errResult(
              `Alter is rate-limiting requests right now. ` +
                `Tell the user to try ${provider} again in about ${formatWait(e.retryAfter ?? 60)}.`,
            );
          }
          if (e instanceof BackendError) {
            const provider = providerDisplayName(spec.provider);
            // Operator-visible: full cause + status/code for on-call to grep.
            api.logger.warn(
              `[alter] ${spec.name} BackendError calling ${spec.provider}: ${e.message} ` +
                `(status=${backendStatus ?? "?"} code=${backendCode ?? "none"})` +
                hintSuffix(e),
            );
            // A 429 without a code the SDK types (the typed ones are handled
            // above): still a rate limit, so the answer is "wait", not "give up".
            if (backendStatus === 429) {
              return errResult(
                `Alter is rate-limiting requests right now. ` +
                  `Tell the user to try ${provider} again in about ${formatWait(60)}.`,
              );
            }
            // Genuinely transient → retry is reasonable: 5xx, no status surfaced,
            // or a 409 because another request is refreshing this grant's token
            // (the backend's own message says "Retry in a moment").
            if (
              backendStatus === undefined ||
              backendStatus >= 500 ||
              e instanceof TokenRefreshInProgressError
            ) {
              return errResult(`Temporary failure calling ${provider}; please retry.`);
            }
            // Other 4xx → not transient. Do NOT echo `e.message`: a raw
            // BackendError string can carry SDK/backend internal detail meant
            // for operator logs (same posture as commands.ts not echoing
            // res.message). The full cause is already in the warn log above; the
            // user gets a generic, non-retryable signal.
            return errResult(
              `${provider} request failed and is not retryable. ` +
                `Relay this to the user plainly; do not suggest reconnecting or retrying.`,
            );
          }
          // Unknown error — log and re-raise so the agent runtime sees it.
          api.logger.warn(
            `[alter] ${spec.name} unhandled error: ${
              e instanceof Error ? `${e.name}: ${e.message}` : String(e)
            }`,
          );
          throw e;
        }
      },
    } as AnyAgentTool;
    return tool;
  };

  api.registerTool(factory, { name: spec.name });
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v === null || typeof v !== "object") return {};
  return v as Record<string, unknown>;
}

// re-exported for tools that build their own TypeBox schemas without a direct dep
export { Type };
