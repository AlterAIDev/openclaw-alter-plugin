import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { RateLimitStore } from "./store.js";

interface LlmOutputUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

interface LlmOutputEvent {
  sessionId?: string;
  usage?: LlmOutputUsage;
}

export function registerRateLimitHook(api: OpenClawPluginApi, store: RateLimitStore): void {
  // Hook fires on every llm_output. We attribute usage to the app_user bound
  // to this session at first identity-resolved tool call. Sessions without a
  // bound app_user (e.g. CLI/scheduled runs) are silently skipped — those
  // calls never went through our identity gate so they're operator-attributed
  // by definition.
  //
  // EVERY hook body is wrapped in try/catch: the OpenClaw event bus runs hook
  // callbacks synchronously inside the LLM stream pipeline, so an unhandled
  // SQLite exception (disk full, locked DB, schema drift) would abort the
  // user-visible stream. Counter accuracy is best-effort; stream integrity is
  // not.
  api.registerHook(
    "llm_output",
    (event) => {
      try {
        const e = event as LlmOutputEvent;
        if (!e.sessionId || !e.usage) return;
        const appUserId = store.appUserForSession(e.sessionId);
        if (!appUserId) return;
        const input = typeof e.usage.input === "number" ? e.usage.input : 0;
        const output = typeof e.usage.output === "number" ? e.usage.output : 0;
        if (input === 0 && output === 0) return;
        store.add(appUserId, input, output);
      } catch (err) {
        api.logger.warn(
          `[alter] rate-limit counter update failed (continuing): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    },
    { name: "alter:rate-limit-counter", description: "Counts per-user LLM usage for daily caps" },
  );

  api.registerHook(
    "session_end",
    (event) => {
      try {
        const e = event as { sessionId?: string };
        if (!e.sessionId) return;
        store.forgetSession(e.sessionId);
      } catch (err) {
        api.logger.warn(
          `[alter] session_end cleanup failed (continuing): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    },
    { name: "alter:session-end-cleanup", description: "Drops session→app_user binding on session end" },
  );
}
