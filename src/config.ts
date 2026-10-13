import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export interface AlterPluginConfig {
  agentApiKeyEnv: string;
  appApiKeyEnv: string;
  stateHmacSecretEnv: string;
  dbEncryptionKeyEnv: string;
  baseUrl: string;
  walletBaseUrl: string;
  publicBaseUrl: string;
  channelHashSalt: string;
  rateLimitInputTokensPerDay: number;
  rateLimitOutputTokensPerDay: number;
}

const DEFAULTS = {
  agentApiKeyEnv: "OPENCLAW_ALTER_AGENT_API_KEY",
  appApiKeyEnv: "OPENCLAW_ALTER_APP_API_KEY",
  stateHmacSecretEnv: "OPENCLAW_ALTER_STATE_HMAC_SECRET",
  dbEncryptionKeyEnv: "OPENCLAW_ALTER_DB_KEY",
  baseUrl: "https://backend.alterauth.com",
  walletBaseUrl: "https://wallet.alterauth.com",
  rateLimitInputTokensPerDay: 200_000,
  rateLimitOutputTokensPerDay: 50_000,
} as const;

/**
 * What a URL setting may be: https://, or http:// on a loopback host for a
 * gateway on a developer's machine (`pnpm dev`; the Alter SDK allows the same
 * for its base URL). Anything another machine can reach must be https://.
 *
 * This is the exact `pattern` of the URL settings in openclaw.plugin.json,
 * which OpenClaw checks before the plugin loads (a test keeps the two equal),
 * so the plugin and the manifest accept the same strings.
 */
export const URL_SETTING_PATTERN =
  "^(https://|http://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:[0-9]+)?(/|$))";
const URL_SETTING = new RegExp(URL_SETTING_PATTERN);

/** Matches the pattern and parses (the pattern alone lets through e.g. port 99999). */
function isAllowedUrl(value: string): boolean {
  return URL_SETTING.test(value) && URL.canParse(value);
}

export function loadConfig(api: OpenClawPluginApi): AlterPluginConfig {
  const raw = (api.pluginConfig ?? {}) as Partial<AlterPluginConfig>;

  const required = ["publicBaseUrl", "channelHashSalt"] as const;
  for (const key of required) {
    if (!raw[key] || typeof raw[key] !== "string") {
      throw new Error(
        `[alter] missing required plugin config key: ${key}. ` +
        `Set it in the plugin config (see openclaw.plugin.json).`,
      );
    }
  }

  for (const key of ["publicBaseUrl", "baseUrl", "walletBaseUrl"] as const) {
    const val = raw[key] ?? (key === "baseUrl" ? DEFAULTS.baseUrl : key === "walletBaseUrl" ? DEFAULTS.walletBaseUrl : "");
    if (val && !isAllowedUrl(val)) {
      throw new Error(
        `[alter] config.${key} must use https:// scheme (http:// only for localhost); got: ${val}`,
      );
    }
  }

  if ((raw.channelHashSalt ?? "").length < 16) {
    throw new Error(`[alter] config.channelHashSalt must be at least 16 chars`);
  }

  return {
    agentApiKeyEnv: raw.agentApiKeyEnv ?? DEFAULTS.agentApiKeyEnv,
    appApiKeyEnv: raw.appApiKeyEnv ?? DEFAULTS.appApiKeyEnv,
    stateHmacSecretEnv: raw.stateHmacSecretEnv ?? DEFAULTS.stateHmacSecretEnv,
    dbEncryptionKeyEnv: raw.dbEncryptionKeyEnv ?? DEFAULTS.dbEncryptionKeyEnv,
    baseUrl: raw.baseUrl ?? DEFAULTS.baseUrl,
    walletBaseUrl: raw.walletBaseUrl ?? DEFAULTS.walletBaseUrl,
    publicBaseUrl: raw.publicBaseUrl!,
    channelHashSalt: raw.channelHashSalt!,
    rateLimitInputTokensPerDay:
      raw.rateLimitInputTokensPerDay ?? DEFAULTS.rateLimitInputTokensPerDay,
    rateLimitOutputTokensPerDay:
      raw.rateLimitOutputTokensPerDay ?? DEFAULTS.rateLimitOutputTokensPerDay,
  };
}
