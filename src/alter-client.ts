import { AsyncLocalStorage } from "node:async_hooks";
import {
  Agent,
  AgentError,
  App,
  InsufficientScopeError,
  PolicyViolationError,
  ReAuthRequiredError,
} from "@alter-ai/alter-sdk";
import type { AlterPluginConfig } from "./config.js";
import type { AlterPluginSecrets } from "./secrets.js";

export const currentUserJwt = new AsyncLocalStorage<string | undefined>();

/**
 * True when Alter rejected the end user's sign-in JWT itself (401
 * `jwt_validation_error`: bad signature, expired at the IdP, wrong iss/aud, a
 * key lost to JWKS rotation). The locally-decoded `exp` can't catch these.
 *
 * The SDK has no subclass for it: it throws a plain `ReAuthRequiredError`,
 * the parent of the grant terminals, so the backend code is the only way to
 * tell it apart. The distinction matters: the grant is fine and a reconnect
 * can't help (the connect flow runs under the same rejected token).
 *
 * A fresh sign-in is the only thing the plugin can offer, but it doesn't always
 * work. Alter sends the same code when IT can't verify the token: the IdP's
 * JWKS or OIDC discovery endpoint is down or returns garbage. Then every new
 * token fails too, until the IdP recovers. The two cases look identical here;
 * the backend's reason ("JWKS fetch failed: …", "OIDC discovery request
 * failed …") in the warn log is what tells them apart.
 */
export function isUserTokenRejected(e: unknown): boolean {
  return e instanceof ReAuthRequiredError && e.details.error === "jwt_validation_error";
}

/**
 * `"deprovisioned"` / `"suspended"` when Alter refused the call because the end
 * user's identity is no longer active, else undefined. Only an administrator
 * can fix either one; reconnecting, retrying, or signing in again can't.
 *
 * The backend answers with a 403 `user_deprovisioned` / `user_suspended`, which
 * the SDK surfaces as a plain `PolicyViolationError` (its class for any 403
 * code it doesn't type more narrowly), so this keys on `policyError`. Test it
 * before any generic `PolicyViolationError` handling.
 */
export function identityTerminal(e: unknown): "deprovisioned" | "suspended" | undefined {
  if (!(e instanceof PolicyViolationError)) return undefined;
  if (e.policyError === "user_deprovisioned") return "deprovisioned";
  if (e.policyError === "user_suspended") return "suspended";
  return undefined;
}

/**
 * Log suffix carrying the backend's remediation hint on a typed key-liveness
 * 401 (`InvalidKeyError`, `KeyRevokedError`, `AgentInactiveError`, … — all
 * `AgentError`s). Operator-only: an `InvalidKeyError` hint is how the logs say
 * that a key minted before Alter's September 2026 key-security upgrade must be
 * replaced, which `e.message` alone does not.
 */
export function hintSuffix(e: unknown): string {
  return e instanceof AgentError && e.hint ? ` hint=${JSON.stringify(e.hint)}` : "";
}

/**
 * The scopes one of this deployment's Alter API keys is missing, when Alter
 * refused the call for that reason (403 `insufficient_scope`), else undefined.
 *
 * This is an operator misconfiguration, not something the user can fix or wait
 * out: the key was minted without a scope the plugin needs (the list is in
 * OPERATOR_SETUP.md). It breaks the same call for every user until the key is
 * fixed, so callers log it at error level with the scope names and tell the
 * user plainly, instead of "try again".
 */
export function missingKeyScopes(e: unknown): string[] | undefined {
  if (!(e instanceof InsufficientScopeError)) return undefined;
  return e.missing.length > 0 ? [...e.missing] : [...e.required];
}

/** What to tell a user when {@link missingKeyScopes} matched. */
export const KEY_SCOPE_MESSAGE =
  "This assistant's Alter API key is missing a permission it needs, so this can't work " +
  "until the operator fixes the key. Retrying or signing in again won't help.";

/** The operator log line for a {@link missingKeyScopes} failure while `doing`. */
export function keyScopeLog(doing: string, scopes: readonly string[]): string {
  return (
    `could not ${doing}: the Alter API key is missing scope(s) ` +
    `[${scopes.join(", ") || "not reported"}]. Add them to the key in the Alter portal ` +
    `(required scopes are listed in OPERATOR_SETUP.md).`
  );
}

const USER_SCOPED_APP_METHODS = new Set<string | symbol>([
  "listGrants",
  "revokeGrant",
  "revokeDelegation",
]);

function makeJwtRequiredApp(raw: App): App {
  return new Proxy(raw, {
    get(target, prop: string | symbol) {
      // Resolve against `target` (NOT the proxy/receiver) so getters and
      // methods that touch the SDK's private fields run with `this` = the real
      // App instance. The SDK class (__VaultClient) is private-field-heavy
      // (#client, #parent, …); calling/reading those with `this` = the proxy
      // throws "Cannot read private member #client from an object whose class
      // did not declare it" — JS #private fields are not forwardable through a
      // Proxy. This is what broke createAuthSession/pollAuthSession on 0.17.
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") {
        return value;
      }
      if (USER_SCOPED_APP_METHODS.has(prop)) {
        return function (this: unknown, ...args: unknown[]) {
          if (currentUserJwt.getStore() === undefined) {
            throw new Error(
              `[alter] App.${String(prop)}() requires a user JWT in scope. ` +
              `Wrap the call in currentUserJwt.run(jwt, () => app.${String(prop)}(...)).`,
            );
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      // Every other method must be bound to the real instance so its
      // private-field access works when invoked via this proxy.
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
}

export interface AlterClients {
  agent: Agent;
  app: App;
}

export function buildAlterClients(
  cfg: AlterPluginConfig,
  secrets: AlterPluginSecrets,
): AlterClients {
  // The Alter SDK pins its base URL from this env var at constructor time
  // (AppOptions / AgentOptions do not accept a `baseUrl` field). We only
  // set it if it isn't already set so an operator can override per-process.
  // Mutating process.env is unusual but unavoidable until the SDK exposes
  // a constructor option for this.
  if (!process.env.ALTER_BASE_URL) {
    process.env.ALTER_BASE_URL = cfg.baseUrl;
  }
  // Fail-closed userTokenGetter: previously returned "" when no JWT was in
  // AsyncLocalStorage scope, which silently sent an empty x-user-jwt header.
  // For any Agent/App method that requires user identity, the empty header
  // would surface as a 401 with a confusing "missing user token" message
  // from the backend. Throwing here surfaces the misuse at the call site
  // (the missing `currentUserJwt.run(jwt, ...)` wrapper) with a much
  // clearer trace.
  const requireJwt = (label: string) => (): string => {
    const jwt = currentUserJwt.getStore();
    if (!jwt) {
      throw new Error(
        `[alter] ${label}: user JWT not in scope. Wrap the call in ` +
          `currentUserJwt.run(jwt, () => ...) before invoking SDK methods ` +
          `that need user identity.`,
      );
    }
    return jwt;
  };
  const agent = new Agent({
    apiKey: secrets.agentApiKey,
    userTokenGetter: requireJwt("Agent"),
  });
  const rawApp = new App({
    apiKey: secrets.appApiKey,
    userTokenGetter: requireJwt("App"),
  });
  const app = makeJwtRequiredApp(rawApp);
  // Lifecycle: these are process-lifetime singletons. The SDK's `close()`
  // drains pending audit + background tasks, but OpenClaw's plugin-entry
  // `register()` exposes no shutdown/dispose hook where we could call it, so we
  // intentionally never close them — the clients live until the gateway
  // process exits, when the OS reclaims the sockets. The only cost is that an
  // in-flight audit buffer may not flush on an abrupt exit; there is no
  // per-request client to leak. (The operator CLI, which constructs
  // short-lived App instances, DOES close them in a try/finally.)
  return { agent, app };
}
