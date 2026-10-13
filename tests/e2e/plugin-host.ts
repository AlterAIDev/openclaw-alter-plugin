// A stand-in for the OpenClaw gateway: loads the real plugin entry
// (src/index.ts) and records what it registers, the way OpenClaw does at boot.
// Tests then act as chat users: run `/alter ...` commands, call tools with the
// context a Slack or Discord message carries, and hit the plugin's HTTP routes
// over real HTTP. The Alter SDK inside the plugin is real too; point it at
// dev/fake-alter.mjs (or a real Alter backend) with `alterUrl`.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { vi } from "vitest";
import { fakeApiKey } from "../../dev/fake-alter.mjs";
import plugin from "../../src/index.js";
import { closeDatabase } from "../../src/sqlite.js";

type RouteHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean | void> | boolean | void;
type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean };
type Tool = { name: string; execute: (callId: string, params: unknown) => Promise<ToolResult> };
type ToolFactory = (ctx: Record<string, unknown>) => Tool;
type CommandResult = { text?: string; isError?: boolean };
type Command = { name: string; handler: (ctx: Record<string, unknown>) => Promise<CommandResult> | CommandResult };

/** One person in one chat channel, as OpenClaw identifies them. */
export interface ChatUser {
  channel: string;
  senderId: string;
  /** With session.dmScope "per-channel-peer", each (channel, sender) DM is its own session. */
  sessionId: string;
}

export function chatUser(channel: string, senderId: string): ChatUser {
  return { channel, senderId, sessionId: `agent:main:${channel}:direct:${senderId}` };
}

export interface Reply {
  text: string;
  isError: boolean;
}

export interface LogLine {
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface PluginHost {
  /** The host's HTTP server. Also the plugin's `publicBaseUrl`, so connect callbacks land here. */
  readonly baseUrl: string;
  readonly workspaceDir: string;
  readonly toolNames: string[];
  readonly commandNames: string[];
  readonly routePaths: string[];
  readonly hookNames: string[];
  /** Lifecycle hooks registered with `api.on`, e.g. `gateway_stop`. */
  readonly lifecycleHookNames: string[];
  readonly cliRegistered: boolean;
  readonly logs: LogLine[];
  /** Call a registered tool the way the agent runtime does for a message from `user`. */
  callTool(user: ChatUser, name: string, params?: Record<string, unknown>): Promise<Reply>;
  /** Run `/<name> <args>` as `user`. */
  command(user: ChatUser, args: string, name?: string): Promise<Reply>;
  /** Fire a registered hook, e.g. `llm_output`. */
  emit(hook: string, event: unknown): void;
  /** Stop the way the gateway does (fires `gateway_stop`), then stop serving. Keeps the workspace unless `removeWorkspace` is set. */
  close(opts?: { removeWorkspace?: boolean }): Promise<void>;
}

export interface PluginHostOptions {
  /** Alter backend the SDK talks to (sets ALTER_BASE_URL before the plugin builds its clients). */
  alterUrl: string;
  /** Reuse a workspace (e.g. to test a restart). Default: a fresh temp dir. */
  workspaceDir?: string;
  /** Extra plugin config merged over the defaults. */
  pluginConfig?: Record<string, unknown>;
  /** Secrets for this host only; the rest are this test process's defaults, which the fake backend accepts. */
  secrets?: Partial<Record<keyof typeof DEFAULT_SECRET_ENV, string>>;
}

const DEFAULT_SECRET_ENV = {
  OPENCLAW_ALTER_AGENT_API_KEY: () => fakeApiKey("agent"),
  OPENCLAW_ALTER_APP_API_KEY: () => fakeApiKey("app"),
  OPENCLAW_ALTER_STATE_HMAC_SECRET: () => randomBytes(32).toString("hex"),
  OPENCLAW_ALTER_DB_KEY: () => randomBytes(32).toString("hex"),
};

/**
 * The default secrets, made once per test process so a restarted host can
 * still open what an earlier one sealed. A host's `secrets` overrides never
 * land here: they apply to that host only.
 */
const processSecrets: Record<string, string> = {};

export async function startPluginHost(opts: PluginHostOptions): Promise<PluginHost> {
  // Secrets are process-wide (the plugin reads env vars), so set all of them for every host.
  for (const [name, make] of Object.entries(DEFAULT_SECRET_ENV)) {
    processSecrets[name] ??= make();
    process.env[name] = opts.secrets?.[name as keyof typeof DEFAULT_SECRET_ENV] ?? processSecrets[name];
  }
  process.env.ALTER_BASE_URL = opts.alterUrl;
  const ownWorkspace = opts.workspaceDir === undefined;
  const workspaceDir = opts.workspaceDir ?? mkdtempSync(join(tmpdir(), "alter-e2e-"));

  const routes = new Map<string, RouteHandler>();
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://host").pathname;
    const handler = routes.get(path);
    if (!handler) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    Promise.resolve(handler(req, res)).catch((e: unknown) => {
      logs.push({ level: "error", message: `route ${path} threw: ${String(e)}` });
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const logs: LogLine[] = [];
  const log = (level: LogLine["level"]) => (message: string) => logs.push({ level, message });
  const tools = new Map<string, ToolFactory>();
  const commands = new Map<string, Command>();
  const hooks = new Map<string, Array<(event: unknown) => void>>();
  const lifecycleHooks = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  let cliRegistered = false;

  const api = {
    id: "alter",
    name: "Alter Vault",
    rootDir: workspaceDir,
    pluginConfig: {
      publicBaseUrl: baseUrl,
      channelHashSalt: "e2e-channel-hash-salt-0123456789",
      ...opts.pluginConfig,
    },
    logger: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    registerTool: (factory: ToolFactory, meta: { name: string }) => {
      tools.set(meta.name, factory);
    },
    registerCommand: (command: Command) => {
      commands.set(command.name, command);
    },
    registerHttpRoute: (route: { path: string; handler: RouteHandler }) => {
      routes.set(route.path, route.handler);
    },
    registerHook: (name: string, fn: (event: unknown) => void) => {
      hooks.set(name, [...(hooks.get(name) ?? []), fn]);
    },
    registerCli: () => {
      cliRegistered = true;
    },
    on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => {
      lifecycleHooks.set(name, [...(lifecycleHooks.get(name) ?? []), fn]);
    },
  };
  try {
    (plugin as unknown as { register: (api: unknown) => void }).register(api);
  } catch (e) {
    // A boot that fails leaves nothing behind: no listening server, no temp dir.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (ownWorkspace) rmSync(workspaceDir, { recursive: true, force: true });
    throw e;
  }

  let calls = 0;
  const text = (content: ToolResult["content"]) =>
    (content ?? []).map((c) => c.text ?? "").join("");

  return {
    baseUrl,
    workspaceDir,
    toolNames: [...tools.keys()],
    commandNames: [...commands.keys()],
    routePaths: [...routes.keys()],
    hookNames: [...hooks.keys()],
    lifecycleHookNames: [...lifecycleHooks.keys()],
    cliRegistered,
    logs,
    async callTool(user, name, params = {}) {
      const factory = tools.get(name);
      if (!factory) throw new Error(`tool ${name} is not registered`);
      const tool = factory({
        sessionId: user.sessionId,
        messageChannel: user.channel,
        requesterSenderId: user.senderId,
      });
      calls += 1;
      const result = await tool.execute(`e2e-call-${calls}`, params);
      return { text: text(result.content), isError: result.isError === true };
    },
    async command(user, args, name = "alter") {
      const command = commands.get(name);
      if (!command) throw new Error(`command /${name} is not registered`);
      const result = await command.handler({
        channel: user.channel,
        senderId: user.senderId,
        sessionId: user.sessionId,
        isAuthorizedSender: true,
        args,
        commandBody: `/${name} ${args}`.trim(),
        config: {},
      });
      return { text: result.text ?? "", isError: result.isError === true };
    },
    emit(hook, event) {
      for (const fn of hooks.get(hook) ?? []) fn(event);
    },
    async close({ removeWorkspace = false } = {}) {
      for (const fn of lifecycleHooks.get("gateway_stop") ?? []) await fn({ reason: "test" }, {});
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      closeDatabase();
      if (removeWorkspace) rmSync(workspaceDir, { recursive: true, force: true });
    },
  };
}

/** The first `https?://...` URL in `text`, or throws. */
export function linkIn(text: string): URL {
  const match = /https?:\/\/[^\s<>)"'`]+/.exec(text);
  if (!match) throw new Error(`no link in: ${text}`);
  // A link that ends a sentence keeps the sentence's punctuation in the match.
  return new URL(match[0].replace(/[.,;:!?]+$/, ""));
}

/** Wait until `check` returns a truthy value, e.g. for the plugin's background sign-in poll to land. */
export function eventually<T>(check: () => T | Promise<T>, timeout = 5_000): Promise<T> {
  return vi.waitFor(
    async () => {
      const value = await check();
      if (!value) throw new Error("condition not met yet");
      return value;
    },
    { timeout, interval: 20 },
  );
}
