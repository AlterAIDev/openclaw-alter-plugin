export interface FakeProxyCall {
  /** Who the user token sent with the call belongs to. */
  sub: string;
  /** Whose grant the call ran on. Alter doesn't check that it matches `sub`, so tests must. */
  owner: string;
  /** The id of the user token the call carried (changes when the user signs in again). */
  tokenId: string;
  provider: string;
  /** The grant id the caller sent: the agent's delegation id. */
  grantId: string;
  /** The user's grant that delegation hangs off. */
  userGrantId: string;
  method: string;
  url: string;
  query: Record<string, unknown> | null;
  body: unknown;
  headers: Record<string, string> | null;
  reason: string | null;
  /** Set when the call ran because someone approved it. */
  executedAfterApproval?: boolean;
  /** Set when an injected failure answered the call. */
  failed?: number;
}

export interface FakeGrant {
  /** The user's grant: what the app key lists and revokes. */
  grantId: string;
  /** The agent's delegation on it: what the agent key lists and proxies through. */
  delegationId: string;
  sub: string;
  provider: string;
  status: "active" | "revoked";
  createdAt: string;
}

export type FakeApprovalStatus = "approved" | "executed" | "denied" | "failed";

export interface FakeAlter {
  /** Where the SDK reaches the API (use as ALTER_BASE_URL). */
  readonly url: string;
  /** Where browsers reach the sign-in, connect and approval pages. */
  readonly pageUrl: string;
  /** Finish a sign-in as `name` (each name is a different person). Returns the user's sub. */
  signIn(authUrlOrToken: string, name: string): string;
  /** Complete a connect; returns the URL the browser is sent back to (the plugin's callback). */
  connect(connectUrlOrToken: string, opts?: { deny?: boolean }): string;
  /**
   * Approve or deny a pending action. Approving runs it, unless `running`
   * (status polls answer "approved", then "executing", then it runs) or
   * `failure` (the run fails with that error). Returns the new status.
   */
  decide(
    approvalUrlOrId: string,
    decision: "approved" | "denied",
    opts?: { running?: boolean; failure?: string },
  ): FakeApprovalStatus;
  /** The user revokes `provider` in the Alter Wallet. Returns how many grants it revoked. */
  revokeInWallet(sub: string, provider: string): number;
  /** Alter stops honouring every token issued to `sub` so far. */
  revokeUserTokens(sub: string): void;
  /** Make `sub`'s grants look `ms` older than they are. */
  backdateGrants(sub: string, ms: number): void;
  readonly calls: FakeProxyCall[];
  readonly requests: Array<{ method: string; path: string; role: "agent" | "app" | null }>;
  grantsOf(sub: string): FakeGrant[];
  failNextProxy(status: number, body: unknown, headers?: Record<string, string>): void;
  mintUserToken(sub: string, ttlSeconds?: number): string;
  close(): Promise<void>;
}

/** A key in Alter's format: `alter_ak_…` for an agent, `alter_rk_…` for an app. */
export function fakeApiKey(kind: "agent" | "app"): string;

export function startFakeAlter(opts?: {
  port?: number;
  host?: string;
  publicUrl?: string;
  quiet?: boolean;
}): Promise<FakeAlter>;
