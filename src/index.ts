import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { loadConfig } from "./config.js";
import { loadSecretsFromEnv } from "./secrets.js";
import { buildAlterClients } from "./alter-client.js";
import { IdentityStore } from "./identity/store.js";
import {
  AUTH_SESSION_DEFAULT_TTL_MS,
  AuthPoller,
  AuthSessionStore,
  type PendingAuthSession,
} from "./identity/auth-session.js";
import { decodeJwtPayloadUnsafe } from "./identity/jwt-decode.js";
import { hashIdpSub } from "./identity/sub-hash.js";
import { GrantsStore } from "./grants/store.js";
import { PendingConnectsStore } from "./grants/pending-connects.js";
import { PendingApprovalLock } from "./pending-approval-lock.js";
import { StateHmac, newCsrfNonce, type ConnectStatePayload } from "./grants/state-hmac.js";
import {
  registerConnectRoutes,
  buildConnectReturnUrl,
  newConnectStatePayload,
} from "./grants/connect-routes.js";
import { currentUserJwt } from "./alter-client.js";
import { registerCommands } from "./commands.js";
import { registerCli } from "./cli/index.js";
import { RateLimitStore } from "./rate-limit/store.js";
import { registerRateLimitHook } from "./rate-limit/hook.js";
import { registerAlterTool, type AlterToolDeps } from "./tools/base.js";
import { TOOL_SPECS } from "./tools/registry.js";
import { MemoryStore } from "./memory/store.js";
import { MemoryScopeResolver } from "./memory/scope.js";
import { MEMORY_TOOL_NAMES, registerMemoryTools } from "./memory/tools.js";
import { KEY_LABELS, deriveSubkey } from "./crypto/derive-keys.js";
import { AuthLoginRateLimit, LoginRateLimitedError } from "./identity/login-rate-limit.js";

// Explicit annotation: without it, `tsc` infers a type that references a
// deep openclaw dist chunk path (TS2742, non-portable declaration emit).
const definedPlugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "alter",
  name: "Alter Vault",
  description:
    "Multi-user identity, OAuth grants, HITL approvals, and per-user audit for OpenClaw.",
  register: (api) => {
    const cfg = loadConfig(api);
    const secrets = loadSecretsFromEnv(cfg);
    const clients = buildAlterClients(cfg, secrets);

    const workspaceDir = api.rootDir ?? process.cwd();

    // Derive context-specific subkeys from the operator's single master DB
    // key. HKDF domain-separates the contexts so a compromise of one
    // ciphertext / HMAC cannot be replayed into another. NEVER pass
    // `secrets.masterDbKey` directly to a consumer — always derive.
    const identityJwtSealKey = deriveSubkey(secrets.masterDbKey, KEY_LABELS.IDENTITY_JWT_SEAL);
    const authSessionSealKey = deriveSubkey(secrets.masterDbKey, KEY_LABELS.AUTH_SESSION_SEAL);
    const authSessionLookupHmacKey = deriveSubkey(
      secrets.masterDbKey,
      KEY_LABELS.AUTH_SESSION_LOOKUP_HMAC,
    );

    const identities = new IdentityStore(workspaceDir, identityJwtSealKey);
    const grants = new GrantsStore(workspaceDir);
    const pending = new PendingConnectsStore(workspaceDir);
    const approvalLock = new PendingApprovalLock(workspaceDir);
    const rateLimit = new RateLimitStore(workspaceDir, {
      inputTokensPerDay: cfg.rateLimitInputTokensPerDay,
      outputTokensPerDay: cfg.rateLimitOutputTokensPerDay,
    });
    const stateHmac = new StateHmac(secrets.stateHmacSecret);
    const authSessions = new AuthSessionStore(
      workspaceDir,
      authSessionSealKey,
      authSessionLookupHmacKey,
    );
    const loginRateLimit = new AuthLoginRateLimit();

    const onAuthCompleted = (
      s: PendingAuthSession,
      userToken: string,
      _userInfo: Record<string, unknown>,
    ): void => {
      // Alter pre-verified the JWT (signature + iss + aud + exp + JWKS rotation)
      // before App.pollAuthSession returned it. We decode the payload locally
      // ONLY to extract sub + exp for our index/expiry; we do NOT make trust
      // decisions from the unverified-locally payload.
      let decoded: { sub: string; exp: number };
      try {
        decoded = decodeJwtPayloadUnsafe(userToken);
      } catch (e) {
        api.logger.error(
          `[alter] auth-completed callback: malformed JWT from App.pollAuthSession: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        return;
      }
      const result = identities.upsert({
        channelKind: s.channelKind,
        channelUserId: s.channelUserId,
        appUserId: `idp:${decoded.sub}`,
        idpSub: decoded.sub,
        jwt: userToken,
        jwtExpiresAt: decoded.exp * 1000,
      });
      if (result.status === "rejected_collision") {
        api.logger.warn(
          `[alter] sign-in rejected for (${s.channelKind}, <user>): identity collision ` +
          `with existing app_user. Operator must run ` +
          `\`openclaw alter unlink-channel-user --kind ${s.channelKind} --user-id <id>\` to migrate.`,
        );
        return;
      }
      api.logger.info(
        `[alter] sign-in ${result.status} for (${s.channelKind}, <user>) → ` +
          `app_user sub_h=${hashIdpSub(cfg.channelHashSalt, decoded.sub)}`,
      );
    };

    const authPoller = new AuthPoller(clients.app, authSessions, {
      onCompleted: onAuthCompleted,
      onExpired: (s) => {
        api.logger.info(
          `[alter] sign-in session expired for (${s.channelKind}, <user>) — user must re-run /alter login`,
        );
      },
      onFailed: (s, reason) => {
        api.logger.warn(
          `[alter] sign-in failed for (${s.channelKind}, <user>): ${reason ?? "unknown"}`,
        );
      },
      onCompletedError: (s, err) => {
        // The JWT was issued but our persist (identity_link upsert / SQLite
        // write / AES seal) failed. The session can't be retried as-is — the
        // user must re-run /alter login to mint a new JWT.
        api.logger.error(
          `[alter] sign-in persist FAILED for (${s.channelKind}, <user>): ` +
            (err instanceof Error ? err.message : String(err)) +
            `. User must re-run /alter login.`,
        );
      },
    });

    // On boot, prune stale rows + resume polling for any in-flight sessions
    // that survived a plugin/gateway restart.
    authSessions.pruneExpired(Date.now());
    const resumed = authPoller.resumePending();
    if (resumed > 0) {
      api.logger.info(`[alter] resumed polling for ${resumed} pending sign-in session(s)`);
    }
    // Stop polling when the gateway stops, so a plugin instance that is being
    // replaced never writes a sign-in after the new one has taken over; its
    // pending rows are resumed above on the next boot. Optional-chained so a
    // host without lifecycle hooks still loads the plugin.
    api.on?.("gateway_stop", () => {
      authPoller.stopAll();
    });

    registerConnectRoutes(api, {
      cfg,
      agent: clients.agent,
      grants,
      pending,
      identities,
      stateHmac,
    });

    registerCommands(api, {
      cfg,
      app: clients.app,
      agent: clients.agent,
      identities,
      grants,
      pending,
      approvalLock,
      stateHmac,
      authSessions,
      authPoller,
      loginRateLimit,
    });

    const startLogin = async (
      channelKind: string,
      channelUserId: string,
      chatSessionId: string,
    ): Promise<string> => {
      // Rate-limit sign-in per (channel, user). Each successful sign-in burns
      // ~1 token; a runaway tool-call loop or attacker probing a stolen
      // channel-user pair is denied after the burst.
      const decision = loginRateLimit.check(channelKind, channelUserId);
      if (!decision.allowed) {
        throw new LoginRateLimitedError(decision.retryAfterSeconds);
      }
      const session = await clients.app.createAuthSession();
      authSessions.insert({
        sessionToken: session.sessionToken,
        channelKind,
        channelUserId,
        chatSessionId,
        authUrl: session.authUrl,
        iatMs: Date.now(),
        ttlMs: AUTH_SESSION_DEFAULT_TTL_MS,
        status: "pending",
      });
      const justInserted = authSessions.get(session.sessionToken);
      if (justInserted) authPoller.start(justInserted);
      return session.authUrl;
    };

    const buildConnectUrl = async (
      channelKind: string,
      channelUserId: string,
      appUserId: string,
      provider: string,
      sessionId: string,
    ): Promise<string> => {
      const linkRow = identities.get(channelKind, channelUserId);
      if (!linkRow) {
        return startLogin(channelKind, channelUserId, sessionId);
      }
      const csrfNonce = newCsrfNonce();
      const statePayload: ConnectStatePayload = newConnectStatePayload({
        csrfNonce,
        sessionId,
        channelKind,
        channelUserId,
        appUserId,
        provider,
      });
      const stateToken = stateHmac.sign(statePayload);
      const returnUrl = buildConnectReturnUrl(cfg, stateToken);
      const session = await currentUserJwt.run(linkRow.jwt, async () =>
        clients.agent.createConnectSession({
          allowedProviders: [provider],
          returnUrl,
        }),
      );
      pending.insert({
        csrfNonce,
        sessionId,
        appUserId,
        provider,
        iatMs: statePayload.iatMs,
        ttlMs: statePayload.ttlMs,
      });
      return session.connectUrl;
    };

    const toolDeps: AlterToolDeps = {
      agent: clients.agent,
      identities,
      grants,
      approvalLock,
      rateLimit,
      channelHashSalt: cfg.channelHashSalt,
      startLogin,
      buildConnectUrl,
    };

    registerRateLimitHook(api, rateLimit);
    registerCli(api, { cfg, secrets });

    for (const spec of TOOL_SPECS) {
      registerAlterTool(api, toolDeps, spec);
    }

    // Per-user memory, partitioned by the key Alter derives from the user's JWT
    // (`alter:user:<app_user_id>`) — never by this plugin's local `idp:<sub>`,
    // and never by anything the model supplies. See src/memory/scope.ts.
    registerMemoryTools(api, {
      identities,
      rateLimit,
      memories: new MemoryStore(workspaceDir),
      scopes: new MemoryScopeResolver(clients.agent),
      channelHashSalt: cfg.channelHashSalt,
      startLogin,
    });

    api.logger.info(
      `alter plugin registered (Alter-hosted sign-in flow, ` +
        `${TOOL_SPECS.length} tools + ${MEMORY_TOOL_NAMES.length} memory tools)`,
    );
  },
});

export default definedPlugin;
