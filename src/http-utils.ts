import type { IncomingMessage, ServerResponse } from "node:http";

export function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(html);
}

export function sendRedirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.setHeader("Cache-Control", "no-store");
  res.end();
}

export function parseQuery(req: IncomingMessage, publicBaseUrl: string): URLSearchParams {
  const u = new URL(req.url ?? "/", publicBaseUrl);
  return u.searchParams;
}

const ESCAPE_HTML: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_HTML[c] ?? c);
}

/**
 * Page body input. Callers MUST pick either `text` (auto-escaped, safe by
 * default) or `html` (trusted, ALREADY ESCAPED — used only for static
 * strings interpolating already-escaped user input like
 * `${escapeHtml(provider)}`). Forgetting to specify which form leads to
 * XSS or to over-escaped output.
 */
export type PageBody = { text: string } | { html: string };

function renderBody(body: PageBody): string {
  return "text" in body ? escapeHtml(body.text) : body.html;
}

function pageShell(palette: "error" | "success", title: string, body: PageBody): string {
  const bg = palette === "error" ? "#fff5f5" : "#f0fff4";
  const border = palette === "error" ? "#ffd7d7" : "#c6f6d5";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:560px;padding:0 1rem;color:#222}h1{font-size:1.4rem;margin-bottom:.5rem}p{line-height:1.5}.box{background:${bg};border:1px solid ${border};border-radius:8px;padding:1rem}</style>
</head><body><div class="box"><h1>${escapeHtml(title)}</h1><p>${renderBody(body)}</p></div></body></html>`;
}

export function errorPage(title: string, body: PageBody | string): string {
  // Legacy string overload (deprecated) — treat as already-escaped HTML.
  // Existing callsites pre-escape with `escapeHtml(...)` already; the new
  // typed API at new callsites should use `{text: ...}` / `{html: ...}`.
  const b = typeof body === "string" ? { html: body } : body;
  return pageShell("error", title, b);
}

export function successPage(title: string, body: PageBody | string): string {
  const b = typeof body === "string" ? { html: body } : body;
  return pageShell("success", title, b);
}
