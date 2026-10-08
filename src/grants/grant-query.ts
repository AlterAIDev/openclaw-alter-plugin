import type { Agent, App } from "@alter-ai/alter-sdk";

/**
 * One entry from `App.listGrants` / `Agent.listGrants` — a discriminated
 * union of OAuth and managed-secret grants. Both SDK methods return the same
 * `UnifiedGrantListResult`, so we infer the item shape from `App` and reuse it
 * for the agent-delegated view too; it tracks the installed SDK without a
 * named import that could drift.
 */
export type GrantItem = Awaited<ReturnType<App["listGrants"]>>["grants"][number];
export type OAuthGrantItem = Extract<GrantItem, { grantKind: "oauth" }>;

const LIST_GRANTS_PAGE_SIZE = 100;
const MAX_LIST_GRANTS_PAGES = 10;

export interface ActiveGrantFilter {
  provider: string;
  /**
   * When set, only grants created at/after this ISO timestamp qualify. Used by
   * the connect callback to correlate the just-completed OAuth flow to its
   * delegation. Omit for the cache-miss probe, which takes the newest active
   * delegation regardless of age.
   */
  createdSinceIso?: string;
}

/**
 * Pick the newest **active** OAuth grant for a provider from a set of
 * `Agent.listGrants` rows — i.e. the agent's own DELEGATION (agent-typed child
 * grant) for that provider+user. Returns `undefined` when none qualify.
 *
 * WHY the agent's delegation, not the user's grant: the plugin calls provider
 * APIs through `agent.proxyRequest`, an AGENT caller. The backend resolves an
 * agent caller only through its delegation edges — a delegation IS an
 * agent-typed child grant addressed by its own id. Handing `proxyRequest` a
 * USER-principal grant id (which the agent was never delegated) is unreachable
 * under any agent edge and comes back as an opaque 404 `grant_not_found`. So we
 * select from `Agent.listGrants({ endUserToken })`, whose rows are exactly the
 * agent's usable delegations for that user; every returned oauth+provider row
 * is addressable by `proxyRequest({ grantId })`. We deliberately do NOT filter
 * on `principalType` — the agent-delegated view already scopes to the agent's
 * usable edges, and the old `principalType === "user"` filter was the bug that
 * selected an unusable grant.
 *
 * The `status === "active"` check is load-bearing for wallet-revoke handling.
 * When a user removes a grant/delegation in the Alter wallet, it does not
 * vanish from `listGrants` — it comes back with `status: "revoked"` (or
 * "expired"). Selecting it would re-cache a dead `grant_id`, and the next
 * `agent.proxyRequest` would fail with a grant error. Filtering to active means
 * a revoked delegation reads as "not connected", so the caller sends the user
 * back through the connect flow instead of caching a corpse.
 */
export function selectActiveAgentOAuthGrant(
  grants: GrantItem[],
  filter: ActiveGrantFilter,
): OAuthGrantItem | undefined {
  const candidates = grants
    .filter(
      (g): g is OAuthGrantItem =>
        g.grantKind === "oauth" &&
        g.providerId === filter.provider &&
        g.status === "active" &&
        (filter.createdSinceIso === undefined ||
          (!!g.createdAt && g.createdAt >= filter.createdSinceIso)),
    )
    // Newest first. createdAt is an ISO string, so lexical compare == chrono
    // compare. Missing createdAt sorts last.
    .sort((a, b) => ((a.createdAt ?? "") < (b.createdAt ?? "") ? 1 : -1));
  return candidates[0];
}

/**
 * Drain a paginated `listGrants`-shaped source to completion, bounded by
 * `maxPages`. `fetchPage` runs one page for a given `(limit, offset)` and
 * returns its rows plus whether more remain. Shared by the agent- and app-view
 * paginators below so the loop, the page-size math, and the `maxPages` cap live
 * in exactly one place.
 */
async function collectPages(
  fetchPage: (limit: number, offset: number) => Promise<{ grants: GrantItem[]; hasMore: boolean }>,
  pageSize: number,
  maxPages: number,
): Promise<GrantItem[]> {
  const out: GrantItem[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(pageSize, page * pageSize);
    out.push(...res.grants);
    if (!res.hasMore) break;
  }
  return out;
}

/**
 * Paginate the AGENT's delegated view (`Agent.listGrants`) to completion,
 * bounded by {@link MAX_LIST_GRANTS_PAGES}. Newest-first ordering isn't
 * guaranteed by the SDK, so callers that need a specific delegation must still
 * filter/sort the full set (see {@link selectActiveAgentOAuthGrant}).
 *
 * `endUserToken` scopes the agent's delegated edges to a single end user —
 * without it the agent would list its delegations across every delegating user.
 * The agent is itself the principal, so (unlike `App.listGrants`) there is no
 * `currentUserJwt.run(...)` wrapper: the user identity rides as the explicit
 * `endUserToken` filter.
 */
export async function listAllAgentGrants(
  agent: Agent,
  opts: {
    providerId?: string;
    endUserToken: string;
    pageSize?: number;
    maxPages?: number;
  },
): Promise<GrantItem[]> {
  return collectPages(
    (limit, offset) =>
      agent.listGrants({
        ...(opts.providerId ? { providerId: opts.providerId } : {}),
        endUserToken: opts.endUserToken,
        limit,
        offset,
      }),
    opts.pageSize ?? LIST_GRANTS_PAGE_SIZE,
    opts.maxPages ?? MAX_LIST_GRANTS_PAGES,
  );
}

/**
 * Paginate the USER-owned view (`App.listGrants`) to completion, bounded by
 * {@link MAX_LIST_GRANTS_PAGES}. Used by the `/alter connections` management
 * commands: a user manages (lists / revokes) their OWN base connections, and
 * revoking a base grant cascade-revokes the agent delegations that hang off it.
 * (Delegations themselves can only be revoked by their parent base grant id,
 * which the SDK's grant item does not surface — so base-grant revocation is the
 * management primitive.)
 *
 * The caller MUST wrap this in `currentUserJwt.run(jwt, …)` so the App resolves
 * the grants to the right end user (an unscoped App call would list every grant
 * the application owns).
 */
export async function listAllGrants(
  app: App,
  opts: { providerId?: string; pageSize?: number; maxPages?: number } = {},
): Promise<GrantItem[]> {
  return collectPages(
    (limit, offset) =>
      app.listGrants({
        ...(opts.providerId ? { providerId: opts.providerId } : {}),
        limit,
        offset,
      }),
    opts.pageSize ?? LIST_GRANTS_PAGE_SIZE,
    opts.maxPages ?? MAX_LIST_GRANTS_PAGES,
  );
}
