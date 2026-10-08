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
    if (val && !val.startsWith("https://")) {
      throw new Error(`[alter] config.${key} must use https:// scheme; got: ${val}`);
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
