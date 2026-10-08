import type { AlterPluginConfig } from "./config.js";

export interface AlterPluginSecrets {
  agentApiKey: string;
  appApiKey: string;
  stateHmacSecret: Buffer;
  /**
   * Master DB key. Never use directly — derive a per-context subkey via
   * `deriveSubkey(masterDbKey, KEY_LABELS.*)` so a compromise in one context
   * (e.g. an AEAD known-plaintext attack on identity-jwt blobs) cannot be
   * pivoted into another context (auth-session blobs, lookup HMACs).
   */
  masterDbKey: Buffer;
}

// Alter API key formats have varied across deployments (legacy and current
// key formats, hosted vs. self-hosted vaults). We enforce only
// the length floor here — the real authorization happens server-side when
// the key is presented. Swapping the agent/app env vars now surfaces as a
// clean 401 on the first call instead of a confusing prefix mismatch at boot.
const MIN_KEY_LENGTH = 16;

function readEnvVar(name: string, label: string, minLen: number): string {
  // Trim before validating: a trailing newline copied from a .env file or
  // shell heredoc would otherwise fail the length check with a confusing
  // off-by-N error instead of revealing the actual length.
  const v = (process.env[name] ?? "").trim();
  if (!v || v.length < minLen) {
    throw new Error(
      `[alter] secret env var ${name} is missing or too short (need >=${minLen} chars). ` +
      `${label} must be set in the gateway's environment, not in plugin config.`,
    );
  }
  return v;
}

function readApiKey(envName: string, label: string): string {
  return readEnvVar(envName, label, MIN_KEY_LENGTH);
}

function hexToBuffer(hex: string, expectedBytes: number, name: string): Buffer {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== expectedBytes * 2) {
    throw new Error(
      `[alter] secret env var ${name} must be ${expectedBytes * 2} hex chars (${expectedBytes} bytes); ` +
      `got length ${hex.length}.`,
    );
  }
  return Buffer.from(hex, "hex");
}

export function loadSecretsFromEnv(cfg: AlterPluginConfig): AlterPluginSecrets {
  return {
    agentApiKey: readApiKey(cfg.agentApiKeyEnv, "Alter agent API key"),
    appApiKey: readApiKey(cfg.appApiKeyEnv, "Alter app API key"),
    stateHmacSecret: hexToBuffer(
      readEnvVar(cfg.stateHmacSecretEnv, "Connect-state HMAC secret", 64),
      32,
      cfg.stateHmacSecretEnv,
    ),
    masterDbKey: hexToBuffer(
      readEnvVar(cfg.dbEncryptionKeyEnv, "DB encryption key", 64),
      32,
      cfg.dbEncryptionKeyEnv,
    ),
  };
}
