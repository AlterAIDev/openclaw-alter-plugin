#!/usr/bin/env node
// A local stand-in for the Alter backend, for tests and `pnpm dev`. It speaks
// the HTTP API that @alter-ai/alter-sdk calls, for the methods this plugin
// uses, and keeps everything in memory:
//
//   sign-in      POST /sdk/auth/session, /sdk/auth/poll (long-poll)
//   identity     POST /sdk/identity/resolve
//   grants       POST /sdk/grants/list, /sdk/oauth/connect/session,
//                     /sdk/oauth/grants/{id}/revoke
//   actions      POST /sdk/proxy, GET /sdk/approvals/{id}
//
// The sign-in, connect and approval links it hands out open small pages here
// that stand in for the identity provider, the provider's OAuth consent and
// the Alter Wallet. Tests drive the same steps directly (signIn, connect,
// decide) and can read back every proxied call.
//
// Where it matches Alter, on purpose, because the plugin depends on it:
//
//   - The key says who is calling: an agent key (alter_ak_…) or an app key
//     (alter_rk_…). Connecting a provider creates the user's grant (what the
//     app key lists and revokes) and the agent's delegation on it, a separate
//     grant with its own id (what the agent key lists and proxies through).
//     The agent proxying with the user's grant id gets a 404, as at Alter.
//   - Connecting a provider the user already has reuses their grant and the
//     delegation, keeping the original createdAt.
//   - Revoking the user's grant revokes the delegation too, and revoked grants
//     stay in the lists with status "revoked".
//   - Like Alter, it doesn't check that a proxied grant belongs to the user
//     token sent with it (the plugin relies on user-scoped grant lists for
//     that). It records both on every call so tests can assert they match.
//   - Errors come back the way FastAPI sends them: {"detail": {error, message}}.
//
// What it does not do: verify request signatures, enforce real policies, or
// reach any provider. Writes (any method but GET) need approval, as a typical
// Alter policy would require; reads return canned provider responses.
//
//   node dev/fake-alter.mjs [--port 8787]
import { createServer } from "node:http";
import { randomUUID, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const KEY_FORMAT = /^alter_(ak|rk)_([a-z2-7]{22})_([a-z2-7]{6})$/;
const KEY_ROLE = { ak: "agent", rk: "app" };
const MAX_WAIT_MS = 25_000;
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
const base32 = (n) => [...randomBytes(n)].map((b) => BASE32[b & 31]).join("");

function crc32(text) {
  let crc = 0xffffffff;
  for (const byte of Buffer.from(text, "utf8")) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** The 6-character check a scoped Alter key ends with: CRC-32 of `<type>:<random>`, in base32. */
function keyChecksum(type, random) {
  const crc = crc32(`${type}:${random}`);
  let out = "";
  for (let i = 0; i < 6; i++) out += BASE32[(crc >>> (5 * i)) & 31];
  return out;
}

/** A key in Alter's format: `alter_ak_…` for an agent, `alter_rk_…` for an app. */
export function fakeApiKey(kind) {
  const type = kind === "agent" ? "ak" : "rk";
  const random = base32(22);
  return `alter_${type}_${random}_${keyChecksum(type, random)}`;
}

/** "agent" or "app" for a well-formed agent or app key, else undefined. */
function roleOfKey(apiKey) {
  const m = typeof apiKey === "string" ? KEY_FORMAT.exec(apiKey) : null;
  return m && keyChecksum(m[1], m[2]) === m[3] ? KEY_ROLE[m[1]] : undefined;
}

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const iso = (ms) => new Date(ms).toISOString();
const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Canned upstream responses, keyed by a substring of the provider URL. */
const UPSTREAM = [
  ["api.github.com/search/issues", (call) => ({
    total_count: 1,
    items: [{ number: 7, title: `Issue matching "${call.query?.q ?? ""}"`, state: "open", html_url: "https://github.com/acme/app/issues/7" }],
  })],
  ["gmail.googleapis.com", () => ({ messages: [{ id: "msg-1", threadId: "thr-1" }], resultSizeEstimate: 1 })],
  ["www.googleapis.com/calendar", () => ({ items: [{ id: "evt-1", summary: "Team sync" }] })],
  ["api.tavily.com", () => ({ results: [{ title: "Example result", url: "https://example.com" }] })],
];

function upstreamBody(call) {
  for (const [match, make] of UPSTREAM) if (call.url.includes(match)) return make(call);
  return { ok: true, method: call.method, url: call.url };
}

/**
 * Start the fake. `port` 0 picks a free port. `publicUrl` is where browsers
 * reach the pages (defaults to the server's own URL).
 */
export async function startFakeAlter({ port = 0, host = "127.0.0.1", publicUrl, quiet = true } = {}) {
  const authSessions = new Map(); // session_token -> { status, user, expiresAt, waiters: Set }
  const connectSessions = new Map(); // session_token -> { provider, returnUrl, sub, expiresAt, used }
  // The user's grant, keyed by its id, with the agent's delegation on it.
  const grants = new Map(); // grant_id -> { grantId, sub, provider, status, createdAt, delegation: { id, createdAt } }
  const delegations = new Map(); // delegation id -> the user's grant it hangs off
  const approvals = new Map(); // approval_id -> { id, groupId, status, call, expiresAt, decidedAt, next, executionError }
  const tokenGeneration = new Map(); // sub -> bumped by revokeUserTokens; older tokens stop working
  const calls = []; // every /sdk/proxy request
  const requests = []; // every /sdk/* request: { method, path, role }
  const injected = []; // queued error responses for /sdk/proxy
  let closing = false;

  const log = (line) => {
    if (!quiet) console.log(`[fake-alter] ${line}`);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`error handling ${req.method} ${req.url}: ${e instanceof Error ? e.stack : String(e)}`);
      if (!res.headersSent) fail(res, 500, "internal_error", "fake-alter failed");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  const url = `http://${host}:${server.address().port}`;
  const pageUrl = (publicUrl ?? url).replace(/\/$/, "");

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  }

  /** An error the way Alter's FastAPI handlers send one. */
  function fail(res, status, error, message, headers) {
    return send(res, status, { detail: { error, message } }, headers);
  }

  function page(res, title, bodyHtml, status = 200) {
    res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
        `<title>${escapeHtml(title)}</title>` +
        `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem}` +
        `button{font:inherit;padding:.4rem 1rem;margin-right:.5rem}input{font:inherit;padding:.3rem}` +
        `.note{color:#666;font-size:.9rem}</style>` +
        `<h1>${escapeHtml(title)}</h1>${bodyHtml}<p class="note">Fake Alter, for local development. Nothing here is real.</p>`,
    );
  }

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) {
      return Object.fromEntries(new URLSearchParams(raw));
    }
    return JSON.parse(raw);
  }

  /** `{ sub, tokenId }` from a JWT this fake minted and still honours, or undefined. */
  function claimsOf(userToken) {
    if (typeof userToken !== "string") return undefined;
    const parts = userToken.split(".");
    if (parts.length !== 3) return undefined;
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (payload.iss !== "fake-alter" || payload.exp * 1000 < Date.now()) return undefined;
      if (typeof payload.sub !== "string") return undefined;
      if (payload.gen !== (tokenGeneration.get(payload.sub) ?? 0)) return undefined;
      return { sub: payload.sub, tokenId: payload.jti };
    } catch {
      return undefined;
    }
  }

  function mintJwt(sub, ttlSeconds = 3600) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: "fake-alter",
      sub,
      email: `${sub}@example.com`,
      iat: now,
      exp: now + ttlSeconds,
      jti: randomUUID(),
      gen: tokenGeneration.get(sub) ?? 0,
    };
    return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.${randomBytes(8).toString("base64url")}`;
  }

  const appUserId = (sub) => `fake-user-${sub}`;

  /** A grant as `grants/list` shows it: the agent sees its delegation, the app sees the user's grant. */
  function grantItem(g, role) {
    const asAgent = role === "agent";
    return {
      grant_kind: "oauth",
      grant_id: asAgent ? g.delegation.id : g.grantId,
      provider_id: g.provider,
      status: g.status,
      created_at: asAgent ? g.delegation.createdAt : g.createdAt,
      principal_type: asAgent ? "agent" : "user",
      access_via: asAgent ? "oauth_delegation" : "ownership",
      scopes: [],
      account_identifier: `${g.sub}@${g.provider}.example`,
      account_display_name: g.sub,
    };
  }

  function approvalStatus(a) {
    const decidedAt = a.decidedAt ? iso(a.decidedAt) : null;
    return {
      approval_id: a.id,
      approval_group_id: a.groupId,
      status: a.status,
      gates: [{ approval_id: a.id, status: a.status, expires_at: iso(a.expiresAt), decided_at: decidedAt }],
      expires_at: iso(a.expiresAt),
      decided_at: decidedAt,
      decision_reason: null,
      executed_at: a.status === "executed" ? decidedAt : null,
      has_result: a.status === "executed",
      execution_error: a.executionError ?? null,
    };
  }

  /** Run an approved action: what Alter does once every gate approves. */
  function execute(a) {
    a.status = "executed";
    calls.push({ ...a.call, executedAfterApproval: true });
  }

  // --- Steps a person takes in a browser; tests call these directly. ---

  /** Finish the sign-in behind `authUrlOrToken` as `name`. Wakes the plugin's poll. */
  function signIn(authUrlOrToken, name) {
    const token = String(authUrlOrToken).split("/").pop();
    const s = authSessions.get(token);
    if (!s) throw new Error(`no sign-in session ${token}`);
    if (s.status !== "pending") throw new Error(`sign-in session already ${s.status}`);
    const sub = String(name).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(sub)) throw new Error(`invalid name: ${name}`);
    s.status = "completed";
    s.user = { sub, userToken: mintJwt(sub) };
    for (const wake of s.waiters) wake();
    log(`signed in ${sub}`);
    return sub;
  }

  /**
   * Complete the connect behind `connectUrlOrToken` and return the URL the
   * browser is sent back to (the plugin's callback). A first connect creates
   * the user's grant and the agent's delegation; connecting a provider the
   * user already has reuses both, as Alter's Connect does.
   */
  function connect(connectUrlOrToken, { deny = false } = {}) {
    const token = String(connectUrlOrToken).split("/").pop();
    const s = connectSessions.get(token);
    if (!s) throw new Error(`no connect session ${token}`);
    if (s.used) throw new Error("connect session already used");
    s.used = true;
    const back = new URL(s.returnUrl);
    if (deny) {
      back.searchParams.set("error", "access_denied");
      return back.toString();
    }
    const existing = [...grants.values()].find(
      (g) => g.sub === s.sub && g.provider === s.provider && g.status === "active",
    );
    if (existing) {
      log(`reconnected ${s.provider} for ${s.sub} (reused grant ${existing.grantId})`);
      return back.toString();
    }
    const createdAt = iso(Date.now());
    const grant = {
      grantId: randomUUID(),
      sub: s.sub,
      provider: s.provider,
      status: "active",
      createdAt,
      delegation: { id: randomUUID(), createdAt },
    };
    grants.set(grant.grantId, grant);
    delegations.set(grant.delegation.id, grant);
    log(`connected ${s.provider} for ${s.sub}`);
    return back.toString();
  }

  /**
   * Approve or deny an action waiting on approval. Approving runs it, as
   * Alter does. `running` makes status polls answer "approved", then
   * "executing", before it runs; `failure` makes the run fail with that error.
   */
  function decide(approvalUrlOrId, decision, { running = false, failure } = {}) {
    const id = String(approvalUrlOrId).split("/").pop();
    const a = approvals.get(id);
    if (!a) throw new Error(`no approval ${id}`);
    if (a.status !== "pending") throw new Error(`approval already ${a.status}`);
    a.decidedAt = Date.now();
    if (decision !== "approved") {
      a.status = "denied";
    } else if (failure !== undefined) {
      a.status = "failed";
      a.executionError = String(failure);
    } else if (running) {
      a.status = "approved";
      a.next = ["executing", "executed"];
    } else {
      execute(a);
    }
    log(`approval ${id} ${a.status}`);
    return a.status;
  }

  /** The user revokes their grant in the Alter Wallet; the delegation goes with it. */
  function revokeInWallet(sub, provider) {
    const revoked = [...grants.values()].filter((g) => g.sub === sub && g.provider === provider && g.status === "active");
    for (const g of revoked) g.status = "revoked";
    log(`${sub} revoked ${provider} in the wallet`);
    return revoked.length;
  }

  /** Alter stops honouring every token it issued to `sub` so far (expired or revoked session). */
  function revokeUserTokens(sub) {
    tokenGeneration.set(sub, (tokenGeneration.get(sub) ?? 0) + 1);
  }

  /** Make `sub`'s grants (and delegations) look `ms` older, e.g. connected long before this connect session. */
  function backdateGrants(sub, ms) {
    for (const g of grants.values()) {
      if (g.sub !== sub) continue;
      g.createdAt = iso(Date.parse(g.createdAt) - ms);
      g.delegation.createdAt = iso(Date.parse(g.delegation.createdAt) - ms);
    }
  }

  // --- HTTP ---

  async function handle(req, res) {
    const { pathname } = new URL(req.url ?? "/", url);
    const method = req.method ?? "GET";

    if (pathname === "/fake/health") return send(res, 200, { ok: true });
    if (pathname.startsWith("/fake/")) return handlePage(req, res, method, pathname);
    if (!pathname.startsWith("/sdk/")) return fail(res, 404, "not_found", "not found");

    const role = roleOfKey(req.headers["x-api-key"]);
    requests.push({ method, path: pathname, role: role ?? null });
    if (!role) {
      return fail(res, 401, "invalid_key", "missing x-api-key, or not an agent (alter_ak_…) or app (alter_rk_…) key");
    }
    const body = method === "GET" ? {} : await readBody(req);

    if (method === "POST" && pathname === "/sdk/auth/session") {
      const token = `st_${randomBytes(12).toString("hex")}`;
      const expiresAt = Date.now() + 600_000;
      authSessions.set(token, { status: "pending", expiresAt, waiters: new Set() });
      return send(res, 200, {
        session_token: token,
        auth_url: `${pageUrl}/fake/sign-in/${token}`,
        expires_in: 600,
        expires_at: iso(expiresAt),
      });
    }

    if (method === "POST" && pathname === "/sdk/auth/poll") {
      const s = authSessions.get(body.session_token);
      if (!s) return fail(res, 404, "session_not_found", "unknown sign-in session");
      const answer = () => {
        if (closing || Date.now() > s.expiresAt) return { status: "expired" };
        if (s.status === "completed") return { status: "completed", user_token: s.user.userToken, user_info: { sub: s.user.sub } };
        return { status: "pending" };
      };
      const first = answer();
      if (first.status !== "pending") return send(res, 200, first);
      // Long-poll: hold the request until sign-in finishes or wait_ms passes.
      const wait = Math.min(Number(body.wait_ms) || 0, MAX_WAIT_MS);
      await new Promise((resolve) => {
        const timer = setTimeout(done, wait);
        function done() {
          clearTimeout(timer);
          s.waiters.delete(done);
          resolve();
        }
        s.waiters.add(done);
      });
      return send(res, 200, answer());
    }

    // Everything below acts for a signed-in user, except approval status.
    if (method === "GET" && pathname.startsWith("/sdk/approvals/")) {
      const a = approvals.get(decodeURIComponent(pathname.slice("/sdk/approvals/".length)));
      if (!a) return fail(res, 404, "approval_not_found", "unknown approval");
      if (a.status === "pending" && Date.now() > a.expiresAt) a.status = "expired";
      const answer = approvalStatus(a);
      // An approval started with decide(…, { running: true }) moves one step per poll.
      const next = a.next?.shift();
      if (next === "executed") execute(a);
      else if (next) a.status = next;
      return send(res, 200, answer);
    }

    const claims = claimsOf(body.user_token);
    if (!claims) return fail(res, 401, "jwt_validation_error", "user token missing, expired, revoked or not issued here");
    const { sub } = claims;

    if (method === "POST" && pathname === "/sdk/identity/resolve") {
      return send(res, 200, {
        app_id: "fake-app",
        app_user_id: appUserId(sub),
        user_status: "active",
        external_subject_id: sub,
        idp_id: null,
        group_ids: [],
        agent_id: null,
        actor_id: null,
        trace: null,
        email: `${sub}@example.com`,
        display_name: sub,
      });
    }

    if (method === "POST" && pathname === "/sdk/grants/list") {
      const all = [...grants.values()].filter((g) => g.sub === sub && (!body.provider_id || g.provider === body.provider_id));
      const offset = Number(body.offset) || 0;
      const limit = Number(body.limit) || 100;
      const pageItems = all.slice(offset, offset + limit);
      return send(res, 200, {
        grants: pageItems.map((g) => grantItem(g, role)),
        total: all.length,
        limit,
        offset,
        has_more: offset + pageItems.length < all.length,
      });
    }

    if (method === "POST" && pathname === "/sdk/oauth/connect/session") {
      const provider = Array.isArray(body.allowed_providers) ? body.allowed_providers[0] : undefined;
      if (!provider || typeof body.return_url !== "string") {
        return fail(res, 400, "invalid_request", "allowed_providers and return_url are required");
      }
      const token = `cs_${randomBytes(12).toString("hex")}`;
      const expiresAt = Date.now() + 600_000;
      connectSessions.set(token, { provider, returnUrl: body.return_url, sub, expiresAt, used: false });
      return send(res, 200, {
        session_token: token,
        connect_url: `${pageUrl}/fake/connect/${token}`,
        expires_in: 600,
        expires_at: iso(expiresAt),
      });
    }

    // Revoking takes the user's grant id (a delegation id is a 404) and
    // revokes the agent's delegation on it too.
    const revoke = /^\/sdk\/oauth\/grants\/([0-9a-f-]{36})\/revoke$/.exec(pathname);
    if (method === "POST" && revoke) {
      const g = grants.get(revoke[1]);
      if (!g || g.sub !== sub) return fail(res, 404, "grant_not_found", "no such grant");
      g.status = "revoked";
      return send(res, 200, { success: true, message: "revoked", grant_id: g.grantId, revoked_at: iso(Date.now()) });
    }

    if (method === "POST" && pathname === "/sdk/proxy") {
      // The agent addresses its delegation, never the user's grant.
      const g = role === "agent" ? delegations.get(body.grant_id) : grants.get(body.grant_id);
      if (!g) return fail(res, 404, "grant_not_found", "no grant with this id is reachable by this caller");
      if (g.status !== "active") return fail(res, 403, "grant_revoked", "grant was revoked");
      if (g.sub !== sub) log(`WARNING: ${sub}'s token was sent with ${g.sub}'s grant; the call runs on ${g.sub}'s account`);
      const call = {
        sub,
        owner: g.sub,
        tokenId: claims.tokenId,
        provider: g.provider,
        grantId: String(body.grant_id),
        userGrantId: g.grantId,
        method: String(body.method),
        url: String(body.url),
        query: body.query_params ?? null,
        body: body.body ?? null,
        headers: body.headers ?? null,
        reason: body.reason ?? null,
      };
      const failure = injected.shift();
      if (failure) {
        calls.push({ ...call, failed: failure.status });
        const body = failure.body !== null && typeof failure.body === "object" && "detail" in failure.body
          ? failure.body
          : { detail: failure.body };
        return send(res, failure.status, body, failure.headers);
      }
      if (call.method !== "GET") {
        const id = `ap_${randomBytes(8).toString("hex")}`;
        const expiresAt = Date.now() + 3_600_000;
        approvals.set(id, { id, groupId: `grp_${id}`, status: "pending", call, expiresAt, decidedAt: null });
        const approvalUrl = `${pageUrl}/fake/approve/${id}`;
        return send(res, 202, {
          approval_id: id,
          approval_group_id: `grp_${id}`,
          status: "pending",
          expires_at: iso(expiresAt),
          expires_in: 3600,
          approval_url: approvalUrl,
          gates: [{ approval_id: id, expires_at: iso(expiresAt), expires_in: 3600, approval_url: approvalUrl }],
        });
      }
      calls.push(call);
      const upstream = Buffer.from(JSON.stringify(upstreamBody(call)));
      return send(res, 200, {
        status_code: 200,
        headers: { "content-type": "application/json" },
        body_b64: upstream.toString("base64"),
        body_truncated: false,
        duration_ms: 1,
      });
    }

    log(`unhandled ${method} ${pathname}`);
    return fail(res, 404, "not_found", `fake-alter does not implement ${method} ${pathname}`);
  }

  async function handlePage(req, res, method, pathname) {
    const [, , kind, token] = pathname.split("/");
    const form = method === "POST" ? await readBody(req) : {};
    try {
      if (kind === "sign-in") {
        const s = authSessions.get(token);
        if (!s) return page(res, "Sign-in link not found", "<p>This link is unknown or the fake was restarted.</p>", 404);
        if (method === "POST") {
          const sub = signIn(token, form.name ?? "");
          return page(res, "Signed in", `<p>Signed in as <b>${escapeHtml(sub)}</b>. Go back to the chat.</p>`);
        }
        if (s.status !== "pending") return page(res, "Already used", "<p>This sign-in link was already used.</p>");
        return page(res, "Sign in",
          `<form method="post"><p>Sign in as <input name="name" value="alice" pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}" required></p>` +
            `<button>Sign in</button></form><p class="note">Each name is a different person.</p>`);
      }
      if (kind === "connect") {
        const s = connectSessions.get(token);
        if (!s) return page(res, "Connect link not found", "<p>This link is unknown or the fake was restarted.</p>", 404);
        if (method === "POST") {
          res.writeHead(302, { Location: connect(token, { deny: form.decision === "deny" }) });
          return res.end();
        }
        if (s.used) return page(res, "Already used", "<p>This connect link was already used.</p>");
        return page(res, `Connect ${s.provider}`,
          `<p>Let the agent use <b>${escapeHtml(s.provider)}</b> as <b>${escapeHtml(s.sub)}</b>?</p>` +
            `<form method="post"><button name="decision" value="allow">Allow</button>` +
            `<button name="decision" value="deny">Deny</button></form>`);
      }
      if (kind === "approve") {
        const a = approvals.get(token);
        if (!a) return page(res, "Approval not found", "<p>This approval is unknown or the fake was restarted.</p>", 404);
        if (method === "POST") {
          const status = decide(token, form.decision === "approve" ? "approved" : "denied");
          return page(res, status === "executed" ? "Approved" : "Denied", `<p>The action was ${status === "executed" ? "approved and run" : "denied"}. Go back to the chat.</p>`);
        }
        if (a.status !== "pending") return page(res, "Already decided", `<p>This action is ${escapeHtml(a.status)}.</p>`);
        return page(res, "Approve action",
          `<p><b>${escapeHtml(a.call.sub)}</b>'s agent wants to call:</p><pre>${escapeHtml(`${a.call.method} ${a.call.url}`)}\n${escapeHtml(JSON.stringify(a.call.body, null, 2) ?? "")}</pre>` +
            `<form method="post"><button name="decision" value="approve">Approve</button>` +
            `<button name="decision" value="deny">Deny</button></form>`);
      }
    } catch (e) {
      return page(res, "Error", `<p>${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`, 400);
    }
    return page(res, "Not found", "", 404);
  }

  return {
    url,
    pageUrl,
    signIn,
    connect,
    decide,
    /** Every /sdk/proxy call, in order (including ones that ran after approval). */
    calls,
    /** Every /sdk/* request: method and path. */
    requests,
    revokeInWallet,
    revokeUserTokens,
    backdateGrants,
    /** The user's grants, oldest first: the user's grant id and the agent's delegation id on it. */
    grantsOf: (sub) =>
      [...grants.values()]
        .filter((g) => g.sub === sub)
        .map((g) => ({
          grantId: g.grantId,
          delegationId: g.delegation.id,
          sub: g.sub,
          provider: g.provider,
          status: g.status,
          createdAt: g.createdAt,
        })),
    /** Make the next /sdk/proxy call fail with this response; `body` is sent inside FastAPI's {"detail": …}. */
    failNextProxy: (status, body, headers) => injected.push({ status, body, headers }),
    /** Mint a token for `sub`, e.g. to act as a user signed in elsewhere. */
    mintUserToken: mintJwt,
    async close() {
      closing = true;
      // Answer every held poll, so the plugin's sign-in loops end instead of retrying.
      for (const s of authSessions.values()) for (const wake of s.waiters) wake();
      const closed = new Promise((resolve) => server.close(() => resolve()));
      // Let the woken polls answer, then drop keep-alive sockets so close() doesn't wait them out.
      await new Promise((resolve) => setImmediate(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf("--port");
  const fake = await startFakeAlter({ port: i > 0 ? Number(process.argv[i + 1]) : 8787, quiet: false });
  console.log(`[fake-alter] listening on ${fake.url}`);
  process.on("SIGINT", () => void fake.close().then(() => process.exit(0)));
}
