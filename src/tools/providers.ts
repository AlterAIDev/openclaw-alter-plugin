/**
 * Single source of truth for all providers this plugin knows about.
 *
 * Add a new provider here (with its canonical id + display name), then use
 * `ProviderId.X` (or the matching string literal) in your tool spec's
 * `provider` field. The TS type derivation below means any tool spec with
 * a provider id that isn't in this list won't compile.
 *
 * The canonical `id` MUST match the provider id Alter Vault uses server-side
 * (the same string passed to `createConnectSession({ allowedProviders: [id] })`).
 */

export interface ProviderMeta {
  /** Canonical id used in Alter Vault + AlterToolSpec.provider. Lowercase, alnum only. */
  readonly id: string;
  /** Human-facing name shown in connect menus, error messages, etc. */
  readonly displayName: string;
  /**
   * True if end users authorize this provider themselves via OAuth (per-user grant).
   * False for managed/org-level secrets where the operator preconfigures a shared key
   * (e.g. Tavily) — these never appear in user-facing connect menus.
   */
  readonly oauth: boolean;
}

export const PROVIDERS = [
  // Google OAuth grant covers Gmail, Calendar, Drive (one consent, three scopes).
  { id: "google", displayName: "Google (Gmail, Calendar, Drive)", oauth: true },
  { id: "notion", displayName: "Notion", oauth: true },
  { id: "slack", displayName: "Slack", oauth: true },
  { id: "github", displayName: "GitHub", oauth: true },
  { id: "linear", displayName: "Linear", oauth: true },
  { id: "calendly", displayName: "Calendly", oauth: true },
  { id: "linkedin", displayName: "LinkedIn", oauth: true },
  // Alter Vault's canonical id for X is still "twitter" (Provider.TWITTER in
  // the SDK enum) — the rename is a display-name concern only.
  { id: "twitter", displayName: "X (Twitter)", oauth: true },
  // Tavily backs alter_web_search via a shared org-level key — no per-user connect.
  { id: "tavily", displayName: "Web Search (Tavily)", oauth: false },
] as const satisfies ReadonlyArray<ProviderMeta>;

/** Union type of all valid provider ids — drives compile-time validation of tool specs. */
export type ProviderId = (typeof PROVIDERS)[number]["id"];

/** All provider ids, sorted alphabetically. */
export const PROVIDER_IDS: ReadonlyArray<ProviderId> = PROVIDERS
  .map((p) => p.id)
  .slice()
  .sort() as ReadonlyArray<ProviderId>;

/**
 * Provider ids the end user can connect themselves via OAuth.
 * Excludes managed/org-level providers (e.g. Tavily) that the operator preconfigures.
 */
export const OAUTH_PROVIDER_IDS: ReadonlyArray<ProviderId> = PROVIDERS
  .filter((p) => p.oauth)
  .map((p) => p.id)
  .slice()
  .sort() as ReadonlyArray<ProviderId>;

/** Look up a provider's metadata by id. */
export function getProvider(id: string): ProviderMeta | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Get a provider's display name, falling back to the id if unknown. */
export function providerDisplayName(id: string): string {
  return getProvider(id)?.displayName ?? id;
}

/**
 * Aliases that resolve to a canonical provider id beyond the literal name.
 * Add entries here when a provider's user-facing brand differs from its
 * Alter Vault id (e.g. X rebrand: Alter still uses "twitter" server-side).
 */
const PROVIDER_ALIASES: Readonly<Record<string, ProviderId>> = {
  x: "twitter",
  // "x.com" → normalize strips dot → "xcom"; explicit so users can type
  // either the brand or the domain.
  xcom: "twitter",
};

/**
 * Fuzzy-match user input to a canonical provider id.
 *
 * Accepts case variations and stripped punctuation (e.g. "LinkedIn",
 * "linked-in", "Linked In" all → "linkedin"; "X", "x.com" → "twitter").
 * Returns null if no match.
 */
export function matchProviderId(input: string): ProviderId | null {
  const normalized = input.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!normalized) return null;
  const direct = PROVIDER_IDS.find((id) => id.toLowerCase() === normalized);
  if (direct) return direct as ProviderId;
  return PROVIDER_ALIASES[normalized] ?? null;
}
