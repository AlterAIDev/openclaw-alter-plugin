import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { Agent } from "@alter-ai/alter-sdk";
import type { AlterPluginConfig } from "../config.js";
import type { GrantsStore } from "./store.js";
import type { PendingConnectsStore } from "./pending-connects.js";
import {
  listAllAgentGrants,
  selectActiveAgentOAuthGrant,
} from "./grant-query.js";
import type { IdentityStore } from "../identity/store.js";
import { STATE_TYP, StateHmac, type ConnectStatePayload } from "./state-hmac.js";
import {
  errorPage,
  parseQuery,
  sendHtml,
  successPage,
  escapeHtml,
} from "../http-utils.js";
import { ConnectCallbackRateLimit } from "./connect-rate-limit.js";

const CONNECT_TTL_MS = 10 * 60 * 1000;

// We correlate the just-completed OAuth flow to a grant row by filtering
// `g.createdAt >= sinceIso` where `sinceIso` is the iat of our state token.
// If Alter's backend clock is a few seconds behind the plugin host, the
// freshly-minted grant can have a createdAt < sinceIso and be silently
// filtered out, producing a confusing "No matching grant" error. Subtract
// a tolerance window from sinceIso so reasonable skew doesn't break the
// happy path. 60s is the same tolerance the state-hmac "issued-in-future"
// guard uses, so the two are symmetric.
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

export interface ConnectContext {
  cfg: AlterPluginConfig;
  agent: Agent;
  grants: GrantsStore;
  pending: PendingConnectsStore;
  identities: IdentityStore;
  stateHmac: StateHmac;
}

export function buildConnectReturnUrl(cfg: AlterPluginConfig, state: string): string {
  const u = new URL("/alter/connect/cb", cfg.publicBaseUrl);
  u.searchParams.set("state", state);
  return u.toString();
}

export function newConnectStatePayload(args: {
  csrfNonce: string;
  sessionId: string;
  channelKind: string;
  channelUserId: string;
  appUserId: string;
  provider: string;
}): ConnectStatePayload {
  return {
    ...args,
    typ: STATE_TYP.CONNECT,
    iatMs: Date.now(),
    ttlMs: CONNECT_TTL_MS,
  };
}

export function registerConnectRoutes(api: OpenClawPluginApi, ctx: ConnectContext): void {
  // Per-IP token bucket for /alter/connect/cb. The route is internet-reachable
  // (OAuth redirect URI) and every hit does HMAC verify + SQLite work + a
  // listGrants call on success — bound the cost for an attacker.
  const callbackRateLimit = new ConnectCallbackRateLimit();
  // NOTE on `auth: "plugin"`: this signals to OpenClaw that the route is
  // owned/served by this plugin; the OAuth redirect URI MUST be publicly
  // reachable, so we rely on the state HMAC + pending consume + per-IP
  // rate limit below as our security boundary, not on transport auth.
  api.registerHttpRoute({
    path: "/alter/connect/cb",
    auth: "plugin",
    match: "exact",
    handler: async (req, res) => {
      try {
        // Per-IP rate limit — uses the connecting socket's remote address.
        // Behind a reverse proxy without X-Forwarded-For trust this collapses
        // to the proxy's address; that's fine as a global rate-limit fallback
        // and operators with their own ingress can pre-rate-limit upstream.
        //
        // Reject (not bucket-as-"unknown") if the socket has no
        // remoteAddress — sharing one bucket between every such request
        // would collapse all legit users into a single throttled slot if
        // attacker traffic ever exercised that branch. In normal TCP-over-
        // Node operation `remoteAddress` is always present; absence means
        // an abnormal transport (mock, weird socket adapter) — fail closed.
        const ip = req.socket?.remoteAddress;
        if (!ip) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Bad request");
          return true;
        }
        const decision = callbackRateLimit.check(ip);
        if (!decision.allowed) {
          res.statusCode = 429;
          res.setHeader("Retry-After", String(decision.retryAfterSeconds));
          res.setHeader("Cache-Control", "no-store");
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Too many requests. Try again shortly.");
          return true;
        }
        const params = parseQuery(req, ctx.cfg.publicBaseUrl);
        const state = params.get("state");
        const errParam = params.get("error");
        if (errParam) {
          sendHtml(
            res,
            400,
            errorPage("Connect failed", {
              html:
                `The OAuth provider returned an error: <code>${escapeHtml(errParam)}</code>. ` +
                `Re-run /alter connect to start over.`,
            }),
          );
          return true;
        }
        if (!state) {
          sendHtml(
            res,
            400,
            errorPage("Missing state", { text: "This connect link is malformed." }),
          );
          return true;
        }

        const verified = ctx.stateHmac.verify<ConnectStatePayload>(
          state,
          Date.now(),
          STATE_TYP.CONNECT,
        );
        const consumed = ctx.pending.consume(verified.csrfNonce, Date.now());
        if (!consumed) {
          // Same error page whether the nonce never existed, was already
          // consumed, or has expired — distinguishing them lets an attacker
          // probe whether a given csrfNonce has been used. nonces are 24
          // random bytes so probing is statistically hopeless anyway, but
          // there's no reason to leak the bit.
          sendHtml(
            res,
            400,
            errorPage("Connect link unavailable", {
              text: "This connect link can't be used. Re-run /alter connect to start over.",
            }),
          );
          return true;
        }

        const link = ctx.identities.get(verified.channelKind, verified.channelUserId);
        if (!link || link.appUserId !== verified.appUserId) {
          sendHtml(
            res,
            403,
            errorPage("Identity mismatch", {
              text: "The link state does not match a current identity. Re-link via /alter login.",
            }),
          );
          return true;
        }

        const sinceIso = new Date(
          verified.iatMs - CLOCK_SKEW_TOLERANCE_MS,
        ).toISOString();

        // Paginate the AGENT's delegated view (scoped to this end user via
        // `endUserToken`) — a user with many historical delegations for the
        // same provider could push the just-created one past page 1. Then pick
        // the newest ACTIVE delegation created during this connect session. We
        // cache the AGENT'S delegation id (not the user's grant): that is the
        // id `agent.proxyRequest({ grantId })` can resolve. Caching a
        // user-principal grant here is what produced the 404 reconnect loop.
        // The active-only filter means a delegation the user revoked between
        // minting the link and landing here is never selected.
        const allGrants = await listAllAgentGrants(ctx.agent, {
          providerId: verified.provider,
          endUserToken: link.jwt,
        });
        // Prefer the delegation minted DURING this connect session (the
        // since-filter correlates the just-completed OAuth flow to its row).
        let winner = selectActiveAgentOAuthGrant(allGrants, {
          provider: verified.provider,
          createdSinceIso: sinceIso,
        });
        if (!winner) {
          // Empty since-filter does NOT mean failure: when the user already had
          // a credential for this provider, the Connect fast-path REUSES the
          // existing delegation (see the NOTE below) whose createdAt predates
          // this session — so the since-filter drops it and we'd 404 a
          // genuinely-successful reconnect (the "already connected" path this
          // flow explicitly supports). Fall back to the newest ACTIVE delegation
          // regardless of age — the exact selection the cache-miss probe uses.
          winner = selectActiveAgentOAuthGrant(allGrants, {
            provider: verified.provider,
          });
        }

        if (!winner) {
          // Only now is it a genuine miss: no ACTIVE delegation for this
          // provider exists at all (fresh or reused).
          sendHtml(
            res,
            404,
            errorPage("No matching grant", {
              text:
                "We couldn't find an active connection for this provider. " +
                "If you saw the OAuth flow succeed, try /alter connections to confirm and retry.",
            }),
          );
          return true;
        }
        ctx.grants.upsert(verified.appUserId, verified.provider, winner.grantId);

        // NOTE: no "supersede old delegations" cleanup here. Connect resolves
        // through the Connect fast-path when the user already has a credential
        // for the provider, which find-or-mints exactly ONE delegation per
        // (agent, credential) — so re-connecting an existing account reuses the
        // same delegation rather than piling up orphans, and the cache-miss
        // probe always selects the newest active delegation regardless. (A
        // delegation can only be revoked by its PARENT base grant id, which the
        // SDK grant item does not surface; base-grant revocation lives in the
        // `/alter connections` management commands.)

        sendHtml(
          res,
          200,
          successPage(`${verified.provider} connected`, {
            text: "Return to your chat client and ask again.",
          }),
        );
        return true;
      } catch (e) {
        // Log the actual cause for operators (state-mismatch / expired /
        // body-not-parseable / etc.) but hide the diagnostic from the user.
        // The error text would otherwise help an attacker fingerprint our
        // state-token format. The user is told to retry — which is correct
        // for every legitimate failure here.
        api.logger.warn(
          `[alter] /alter/connect/cb failed: ` +
            (e instanceof Error ? `${e.name}: ${e.message}` : String(e)),
        );
        sendHtml(
          res,
          400,
          errorPage("Connect failed", {
            text: "We couldn't complete this connect link. Re-run /alter connect to start over.",
          }),
        );
        return true;
      }
    },
  });
}
