import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { vi, type Mock } from "vitest";
import { Type } from "typebox";
import {
  ApprovalStatus,
  PendingApproval,
  type Agent,
  type ApprovalResult,
  type ApprovalStatusValue,
} from "@alter-ai/alter-sdk";
import { registerAlterTool, type AlterToolDeps, type AlterToolSpec } from "../../src/tools/base.js";
import type { GrantItem } from "../../src/grants/grant-query.js";
import { GrantsStore } from "../../src/grants/store.js";
import { IdentityStore } from "../../src/identity/store.js";
import { PendingApprovalLock, type PendingApprovalRecord } from "../../src/pending-approval-lock.js";
import { RateLimitStore } from "../../src/rate-limit/store.js";
import { closeDatabase } from "../../src/sqlite.js";

/**
 * What `agent.proxyRequest` resolves/rejects with for a given test. The plugin
 * treats the result as either a synchronous `ApprovalResult`, a HITL
 * `PendingApproval`, or a thrown SDK error — a proxy impl returns/throws one of
 * those to drive the branch under test.
 */
export type ProxyImpl = (args: Record<string, unknown>) => Promise<unknown>;

/** Shape of `Agent.listGrants` for the cache-miss probe path. */
export type ListGrantsImpl = (args: {
  providerId?: string;
  endUserToken?: string;
  limit: number;
  offset?: number;
}) => Promise<{
  grants: GrantItem[];
  total: number;
  hasMore: boolean;
  limit: number;
  offset: number;
}>;

export interface ToolHarnessOptions {
  /** `agent.proxyRequest` behavior — return an ApprovalResult/PendingApproval or throw an SDK error. */
  proxy?: ProxyImpl;
  /** `agent.listGrants` behavior — only reached when `seedGrantId` is null (cache-miss probe). */
  listGrants?: ListGrantsImpl;
  /**
   * `agent.getApprovalStatus` behavior — only reached when a `pendingLock` is
   * set (the poll-before-replay short-circuit reconciles the lock against the
   * backend). Return a terminal `ApprovalStatus` to exercise the stale-lock
   * clear, a non-terminal one to keep the short-circuit, or a thrower for the
   * fail-safe (keep-the-lock) path.
   */
  getApprovalStatus?: (approvalId: string) => Promise<ApprovalStatus> | ApprovalStatus;
  /** Marks the spec `hitl: true` so the post-call invariant check fires. */
  hitl?: boolean;
  /**
   * Grant id pre-seeded into the GrantsStore cache for (appUserId, "github").
   * Default "grant-test-1" skips the probe. Pass `null` to leave the cache
   * empty and exercise the `listGrants` probe.
   */
  seedGrantId?: string | null;
  /**
   * Identity link to seed. `undefined` seeds a valid link expiring in 1h;
   * `null` seeds NOTHING (no-link path); an object overrides individual fields
   * (e.g. `{ jwtExpiresAt: Date.now() - 1000 }` for the expired-jwt path).
   */
  identityLink?: {
    appUserId?: string;
    idpSub?: string;
    jwt?: string;
    jwtExpiresAt?: number;
  } | null;
  /** Pre-existing approval lock on the session (for the short-circuit + race tests). */
  pendingLock?: Partial<PendingApprovalRecord> | null;
  /** `buildConnectUrl` behavior — default resolves the reconnect URL; pass a thrower for the fallback path. */
  buildConnectUrl?: (
    channelKind: string,
    channelUserId: string,
    appUserId: string,
    provider: string,
    sessionId: string,
  ) => Promise<string>;
  /** `startLogin` behavior — default resolves a sign-in URL. */
  startLogin?: (
    channelKind: string,
    channelUserId: string,
    sessionId: string,
  ) => Promise<string>;
  /**
   * `spec.toProxyArgs` behavior. Default returns `{ method, url, queryParams }`
   * (a read tool). Override to exercise the call-site remap of the internal
   * `jsonBody`/`headers` contract → the SDK's `json`/`extraHeaders` wire names.
   */
  toProxyArgs?: (params: Record<string, unknown>) => Promise<{
    method: string;
    url: string;
    jsonBody?: unknown;
    headers?: Record<string, string>;
    queryParams?: Record<string, unknown>;
  }>;
  /** Params handed to `tool.execute`. Default `{ q: "x" }` (valid against the spec). */
  params?: Record<string, unknown>;
  /** When true, seed the per-day counter over the cap so `isOverQuota` returns true. */
  overQuota?: boolean;
  /** Override ctx fields — used to exercise the channel guard (`sessionId: null`, etc.). */
  ctx?: {
    sessionId?: string | null;
    messageChannel?: string | null;
    requesterSenderId?: string | null;
  };
}

export interface ToolHarness {
  /** Invoke the registered tool's `execute`. NOT pre-caught — may reject (unknown-error cases). */
  execute: () => Promise<{
    isError: boolean;
    content: Array<{ type: "text"; text: string }>;
    details?: unknown;
  }>;
  /** Convenience: the joined text of the (single) result content block. */
  text: (r: { content: Array<{ text: string }> }) => string;
  grants: GrantsStore;
  identities: IdentityStore;
  approvalLock: PendingApprovalLock;
  rateLimit: RateLimitStore;
  logger: { info: Mock; warn: Mock; error: Mock };
  /** The `vi.fn` wired into `agent.proxyRequest` — assert calls / override with `mockImplementation`. */
  proxy: Mock;
  /** The `vi.fn` wired into `agent.listGrants`. */
  listGrants: Mock;
  /** The `vi.fn` wired into `agent.getApprovalStatus` — assert the stale-lock poll. */
  getApprovalStatus: Mock;
  /** The `vi.fn` wired into the spec's `toProxyArgs` — assert it is skipped on invalid params. */
  toProxyArgs: Mock;
  buildConnectUrl: Mock;
  startLogin: Mock;
  appUserId: string;
  sessionId: string;
  provider: string;
  cleanup: () => void;
}

const QUOTA_CAPS = { inputTokensPerDay: 1000, outputTokensPerDay: 1000 } as const;

/** Minimal TypeBox param schema mirroring a real read tool (`q` required, `perPage` optional). */
const PARAMS = Type.Object({
  q: Type.String({ minLength: 1, maxLength: 512 }),
  perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});

export function makeToolHarness(opts: ToolHarnessOptions = {}): ToolHarness {
  const tmp = mkdtempSync(join(tmpdir(), "alter-tool-"));
  const key = randomBytes(32);

  const sessionId = opts.ctx?.sessionId === undefined ? "sess-1" : opts.ctx.sessionId;
  const messageChannel =
    opts.ctx?.messageChannel === undefined ? "slack" : opts.ctx.messageChannel;
  const requesterSenderId =
    opts.ctx?.requesterSenderId === undefined ? "U123" : opts.ctx.requesterSenderId;

  const appUserId = opts.identityLink?.appUserId ?? "idp:user1";
  const provider = "github";

  const grants = new GrantsStore(tmp);
  const identities = new IdentityStore(tmp, key);
  const approvalLock = new PendingApprovalLock(tmp);
  const rateLimit = new RateLimitStore(tmp, QUOTA_CAPS);

  // Seed the grant cache unless the caller opted into the probe path.
  const seedGrantId = opts.seedGrantId === undefined ? "grant-test-1" : opts.seedGrantId;
  if (seedGrantId !== null) {
    grants.upsert(appUserId, provider, seedGrantId);
  }

  // Seed the identity link (channelKind/channelUserId must match ctx so
  // `identities.get(messageChannel, requesterSenderId)` resolves it).
  if (opts.identityLink !== null && messageChannel !== null && requesterSenderId !== null) {
    identities.upsert({
      channelKind: messageChannel,
      channelUserId: requesterSenderId,
      appUserId,
      idpSub: opts.identityLink?.idpSub ?? "user1",
      jwt: opts.identityLink?.jwt ?? "test.jwt.token",
      jwtExpiresAt: opts.identityLink?.jwtExpiresAt ?? Date.now() + 60 * 60 * 1000,
    });
  }

  if (opts.pendingLock && sessionId !== null) {
    approvalLock.set(sessionId, appUserId, {
      approvalId: opts.pendingLock.approvalId ?? "appr_pre",
      approvalUrl: opts.pendingLock.approvalUrl ?? "https://wallet/approvals/appr_pre",
      toolName: opts.pendingLock.toolName ?? "alter_gmail_send",
      createdAt: opts.pendingLock.createdAt ?? Date.now(),
      // Default a fresh (10-min-out) approval window so a seeded lock is
      // "active" and the short-circuit reconciles it via the poll. Override
      // via `pendingLock.expiresAtMs` to exercise the idle-purge horizon.
      expiresAtMs: opts.pendingLock.expiresAtMs ?? Date.now() + 10 * 60_000,
      ...(opts.pendingLock.gates ? { gates: opts.pendingLock.gates } : {}),
    });
  }

  if (opts.overQuota) {
    rateLimit.add(appUserId, QUOTA_CAPS.inputTokensPerDay, 0);
  }

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const proxy = vi.fn(
    opts.proxy ??
      (async () => {
        throw new Error("proxy not configured for this test");
      }),
  );
  const listGrants = vi.fn(
    opts.listGrants ??
      (async (args: { limit: number; offset?: number }) => ({
        grants: [] as GrantItem[],
        total: 0,
        hasMore: false,
        limit: args.limit,
        offset: args.offset ?? 0,
      })),
  );
  const getApprovalStatus = vi.fn(
    opts.getApprovalStatus ??
      (async () => {
        throw new Error("getApprovalStatus not configured for this test");
      }),
  );

  const agent = { proxyRequest: proxy, listGrants, getApprovalStatus } as unknown as Agent;

  const buildConnectUrl = vi.fn(
    opts.buildConnectUrl ?? (async () => "https://connect.test/reconnect"),
  );
  const startLogin = vi.fn(opts.startLogin ?? (async () => "https://login.test/start"));

  const toProxyArgs = vi.fn(
    opts.toProxyArgs ??
      (async (params: Record<string, unknown>) => ({
        method: "GET",
        url: "https://api.github.com/search/issues",
        queryParams: { q: typeof params["q"] === "string" ? params["q"] : "" },
      })),
  );

  const deps: AlterToolDeps = {
    agent,
    identities,
    grants,
    approvalLock,
    rateLimit,
    channelHashSalt: "test-channel-hash-salt",
    startLogin,
    buildConnectUrl,
  };

  const spec: AlterToolSpec<typeof PARAMS> = {
    name: "alter_test_tool",
    description: "Harness tool exercising registerAlterTool.execute branches.",
    parameters: PARAMS,
    provider,
    hitl: opts.hitl ?? false,
    toProxyArgs,
    formatResult(result: ApprovalResult): unknown {
      try {
        return result.bodyJson();
      } catch {
        return { raw: result.bodyText() };
      }
    },
  };

  // Capture the tool factory registered by registerAlterTool, then invoke it
  // with a fake ctx to obtain the tool whose `execute` is under test.
  let captured: ((ctx: unknown) => { execute: ToolExecute }) | undefined;
  const api = {
    logger,
    registerTool: (
      factory: unknown,
      _opts?: unknown,
    ): void => {
      captured = factory as (ctx: unknown) => { execute: ToolExecute };
    },
  } as unknown as Parameters<typeof registerAlterTool>[0];

  registerAlterTool(api, deps, spec);
  if (!captured) {
    throw new Error("registerAlterTool did not register a tool factory");
  }
  const tool = captured({ sessionId, messageChannel, requesterSenderId });

  const params = opts.params ?? { q: "x" };

  return {
    execute: () =>
      tool.execute("call-1", params) as ReturnType<ToolHarness["execute"]>,
    text: (r) => r.content.map((c) => c.text).join(""),
    grants,
    identities,
    approvalLock,
    rateLimit,
    logger,
    proxy,
    listGrants,
    getApprovalStatus,
    toProxyArgs,
    buildConnectUrl,
    startLogin,
    appUserId,
    sessionId: sessionId ?? "",
    provider,
    cleanup: () => {
      // SEQUENTIAL-ONLY: `closeDatabase()` closes EVERY cached sqlite handle
      // (keyed by workspaceDir), not just this harness's. sqlite.ts exposes no
      // per-workspace close, so a harness that runs concurrently with another
      // would close the other's handle mid-test. Safe today because every test
      // file uses one harness at a time (or cleans up before making the next);
      // if a test ever holds two harnesses live at once, add a per-path close to
      // sqlite.ts and call it here instead.
      closeDatabase();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

type ToolExecute = (
  toolCallId: string,
  params: Record<string, unknown>,
) => Promise<{
  isError: boolean;
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}>;

/** Re-export SDK error/result constructors used across the matrix for one import site. */
export {
  AgentDelegationMissingError,
  AgentNotFoundError,
  AlterValueError,
  ApprovalResult,
  ApprovalStatus,
  BackendError,
  CredentialRevokedError,
  GrantDeletedError,
  GrantExpiredError,
  GrantNotFoundError,
  GrantRevokedError,
  InsufficientScopeError,
  InvalidKeyError,
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

/**
 * A `PendingApproval` shaped like the backend's real 202. The SDK constructor
 * validates the wire shape and throws a BackendError on a missing
 * `approval_group_id` or an empty `gates` (both required since SDK 0.21), so a
 * hand-rolled fixture that omits them silently drives the proxy-error branch
 * instead of the approval branch. Single-gate by default: the top-level fields
 * ARE that gate, exactly as the backend builds it. `extraGateUrls` adds more
 * gates to model an N-of-N multi-party group.
 */
export function pendingApproval(
  approvalId: string,
  approvalUrl: string,
  opts: { extraGateUrls?: string[] } = {},
): PendingApproval {
  const expiresAt = new Date(Date.now() + 600_000);
  const gate = (id: string, url: string) => ({
    approval_id: id,
    expires_at: expiresAt,
    expires_in: 600,
    approval_url: url,
  });
  return new PendingApproval({
    approval_id: approvalId,
    approval_group_id: `grp_${approvalId}`,
    status: "pending",
    expires_at: expiresAt,
    expires_in: 600,
    approval_url: approvalUrl,
    gates: [
      gate(approvalId, approvalUrl),
      ...(opts.extraGateUrls ?? []).map((url, i) => gate(`${approvalId}_g${i + 2}`, url)),
    ],
  });
}

/**
 * An `ApprovalStatus` poll snapshot, shaped like the backend's (same
 * constructor-validation caveat as {@link pendingApproval}). Single-gate by
 * default. A gate reports its approver DECISION, which the backend collapses to
 * `approved` once the group executes, so a gate never carries
 * executing/executed/failed. Pass `gates` to model a multi-party group's
 * per-gate decisions (`status` is then the group's derived status).
 */
export function approvalStatus(
  status: ApprovalStatusValue,
  extra: {
    approvalId?: string;
    hasResult?: boolean;
    executionError?: string | null;
    gates?: Array<{ approvalId: string; status: ApprovalStatusValue }>;
  } = {},
): ApprovalStatus {
  const approvalId = extra.approvalId ?? "appr_pre";
  const expiresAt = new Date(Date.now() + 600_000);
  const gateDecision =
    status === "executing" || status === "executed" || status === "failed" ? "approved" : status;
  const gates = extra.gates ?? [{ approvalId, status: gateDecision }];
  return new ApprovalStatus({
    approval_id: approvalId,
    approval_group_id: `grp_${approvalId}`,
    status,
    gates: gates.map((g) => ({ approval_id: g.approvalId, status: g.status, expires_at: expiresAt })),
    expires_at: expiresAt,
    has_result: extra.hasResult ?? status === "executed",
    execution_error: extra.executionError ?? null,
  });
}

/** Build an OAuth grant row for the probe path (duck-typed to the SDK union). */
export function oauthGrantRow(p: {
  grantId: string;
  providerId?: string;
  status?: string;
  createdAt?: string;
}): GrantItem {
  return {
    grantKind: "oauth",
    grantId: p.grantId,
    providerId: p.providerId ?? "github",
    principalType: "agent",
    status: p.status ?? "active",
    createdAt: p.createdAt ?? "2026-01-01T00:00:00.000Z",
  } as unknown as GrantItem;
}
