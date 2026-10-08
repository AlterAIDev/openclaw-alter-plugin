import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { App } from "@alter-ai/alter-sdk";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { AlterPluginConfig } from "../config.js";
import { IdentityStore } from "../identity/store.js";
import { decodeJwtPayloadUnsafe } from "../identity/jwt-decode.js";
import { hashIdpSub } from "../identity/sub-hash.js";
import { TOOL_NAMES } from "../tools/registry.js";

// Structural type for the CLI registrar's `program` argument. We don't import
// commander directly (not a direct dep) — we just call .command(...).description(...)
// .requiredOption(...).option(...).action(...). The real types live on the
// openclaw side; this is the duck-typed slice we use.
interface CommanderCommand {
  command(name: string): CommanderCommand;
  description(d: string): CommanderCommand;
  requiredOption(flags: string, description?: string, defaultValue?: unknown): CommanderCommand;
  option(flags: string, description?: string, defaultValue?: unknown): CommanderCommand;
  action(fn: (...args: unknown[]) => void | Promise<void>): CommanderCommand;
}
type CliRegistrar = (ctx: { program: CommanderCommand }) => void;
import type { AlterPluginSecrets } from "../secrets.js";
import { openDatabase } from "../sqlite.js";
import { seal, type AeadAad } from "../crypto/jwt-at-rest.js";
import { open as openSeal } from "../crypto/jwt-at-rest.js";
import { KEY_LABELS, deriveSubkey } from "../crypto/derive-keys.js";

interface CliDeps {
  cfg: AlterPluginConfig;
  secrets: AlterPluginSecrets;
}

function aad(channelKind: string, channelUserId: string, rowId: string): AeadAad {
  return { channelKind, channelUserId, rowId };
}

async function loginAction(
  deps: CliDeps,
  opts: { channel: string; user: string; workspaceDir?: string },
): Promise<number> {
  const app = new App({ apiKey: deps.secrets.appApiKey });

  // Wrap the entire post-construction body in try/finally so `app.close()`
  // always runs — previously, an unexpected throw between `authenticate()`
  // and the trailing `app.close()` (e.g. an `identities.upsert` exception)
  // leaked the App's HTTP client + auth-poll loop.
  try {
    process.stdout.write(
      `Opening browser to Alter's hosted sign-in page.\n` +
      `If your browser doesn't open automatically, the URL will be printed below.\n\n`,
    );

    let result;
    try {
      result = await app.authenticate({ timeoutMs: 5 * 60 * 1000 });
    } catch (e) {
      process.stderr.write(
        `\n[alter login] failed: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 2;
    }

    let decoded: { sub: string; exp: number };
    try {
      decoded = decodeJwtPayloadUnsafe(result.userToken);
    } catch (e) {
      process.stderr.write(
        `\n[alter login] got JWT but couldn't decode payload: ${e instanceof Error ? e.message : String(e)}\n`,
      );
      return 3;
    }

    const workspaceDir = opts.workspaceDir ?? process.cwd();
    // Resolve the master DB key from the env name in config. Validate
    // exactly like `secrets.ts` so a key that boots the plugin will also
    // boot the CLI (and vice versa) — non-hex chars were previously
    // accepted here and `Buffer.from(_, "hex")` would silently produce a
    // shorter buffer, surfacing as a confusing GCM "invalid key length"
    // far from the root cause.
    const dbKeyHex = (process.env[deps.cfg.dbEncryptionKeyEnv] ?? "").trim();
    if (!dbKeyHex || dbKeyHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(dbKeyHex)) {
      process.stderr.write(
        `\n[alter login] env var ${deps.cfg.dbEncryptionKeyEnv} must be 64 hex chars (32 bytes).\n`,
      );
      return 4;
    }
    const masterDbKey = Buffer.from(dbKeyHex, "hex");
    const identityJwtSealKey = deriveSubkey(masterDbKey, KEY_LABELS.IDENTITY_JWT_SEAL);
    const identities = new IdentityStore(workspaceDir, identityJwtSealKey);

    const upsertResult = identities.upsert({
      channelKind: opts.channel,
      channelUserId: opts.user,
      appUserId: `idp:${decoded.sub}`,
      idpSub: decoded.sub,
      jwt: result.userToken,
      jwtExpiresAt: decoded.exp * 1000,
    });

    if (upsertResult.status === "rejected_collision") {
      process.stderr.write(
        `\n[alter login] (${opts.channel}, ${opts.user}) is already linked to a different IdP user ` +
        `(app_user=${upsertResult.existingAppUserId}). Run \`openclaw alter unlink-channel-user ` +
        `--kind ${opts.channel} --user-id ${opts.user} --yes\` to clear it first, then re-run /alter login.\n`,
      );
      return 5;
    }

    // `sub` is printed verbatim here because this is interactive operator
    // output from the CLI (not log-shipped). The hashed form is shown
    // alongside so the operator can correlate against ambient log lines
    // that only carry the hash.
    process.stdout.write(
      `\n✅ Logged in.\n` +
      `   sub:           ${decoded.sub}\n` +
      `   sub_h:         ${hashIdpSub(deps.cfg.channelHashSalt, decoded.sub)} (correlation token in logs)\n` +
      `   exp:           ${new Date(decoded.exp * 1000).toISOString()}\n` +
      `   bound under:   (${opts.channel}, ${opts.user})\n` +
      `   status:        ${upsertResult.status}\n\n` +
      `Stored in ${workspaceDir}/.alter/plugin.sqlite (AES-256-GCM, AAD-bound).\n`,
    );
    return 0;
  } finally {
    await app.close();
  }
}

function resolveWorkspaceDir(opts: { workspaceDir?: string }): string {
  // Operators should pass --workspace-dir to match the gateway's runtime dir;
  // process.cwd() is a footgun (CLI launched from a different directory than
  // the gateway would silently target a different .alter/plugin.sqlite).
  return opts.workspaceDir ?? process.cwd();
}

function dbRotateKeyAction(
  deps: CliDeps,
  opts: { newKeyEnv: string; workspaceDir?: string },
): number {
  const newHex = (process.env[opts.newKeyEnv] ?? "").trim();
  if (!newHex || newHex.length !== 64 || !/^[0-9a-fA-F]+$/.test(newHex)) {
    process.stderr.write(
      `[alter db-rotate-key] env var ${opts.newKeyEnv} must hold 64 hex chars (32 bytes)\n`,
    );
    return 2;
  }
  const newMaster = Buffer.from(newHex, "hex");
  const oldMaster = deps.secrets.masterDbKey;
  if (newMaster.equals(oldMaster)) {
    process.stderr.write(`[alter db-rotate-key] new key is identical to current key — no-op\n`);
    return 1;
  }
  // identity_link blobs are sealed under the IDENTITY_JWT_SEAL subkey
  // derived from the master via HKDF. Rotate at the subkey layer so the
  // operator only manages one env-var-shaped secret.
  const oldKey = deriveSubkey(oldMaster, KEY_LABELS.IDENTITY_JWT_SEAL);
  const newKey = deriveSubkey(newMaster, KEY_LABELS.IDENTITY_JWT_SEAL);

  const workspaceDir = resolveWorkspaceDir(opts);
  const db = openDatabase(workspaceDir);

  const rows = db
    .prepare(
      `SELECT channel_kind, channel_user_id, jwt_ciphertext, jwt_nonce, created_at_ms FROM identity_link`,
    )
    .all() as Array<{
    channel_kind: string;
    channel_user_id: string;
    jwt_ciphertext: Uint8Array;
    jwt_nonce: Uint8Array;
    created_at_ms: number;
  }>;

  let rotated = 0;
  let failed = 0;
  for (const row of rows) {
    const rowId = String(row.created_at_ms);
    const aadVal = aad(row.channel_kind, row.channel_user_id, rowId);
    let plaintext: string;
    try {
      plaintext = openSeal(
        { ciphertext: Buffer.from(row.jwt_ciphertext), nonce: Buffer.from(row.jwt_nonce) },
        oldKey,
        aadVal,
      );
    } catch (e) {
      failed++;
      process.stderr.write(
        `[alter db-rotate-key] failed to decrypt ${row.channel_kind}/${row.channel_user_id}: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
      continue;
    }
    const sealed = seal(plaintext, newKey, aadVal);
    db.prepare(
      `UPDATE identity_link
       SET jwt_ciphertext = ?, jwt_nonce = ?, updated_at_ms = ?
       WHERE channel_kind = ? AND channel_user_id = ?`,
    ).run(sealed.ciphertext, sealed.nonce, Date.now(), row.channel_kind, row.channel_user_id);
    rotated++;
  }

  process.stdout.write(
    `[alter db-rotate-key] rotated ${rotated} rows; ${failed} failed; ` +
      `update env var ${deps.cfg.dbEncryptionKeyEnv} to the new key and restart the gateway.\n`,
  );
  return failed === 0 ? 0 : 3;
}

function rotateStateHmacAction(deps: CliDeps): number {
  process.stdout.write(
    [
      `# rotate-state-hmac — Connect-state HMAC rotation`,
      ``,
      `1. Generate a new 32-byte secret:`,
      `   openssl rand -hex 32`,
      ``,
      `2. Set the new value into env var ${deps.cfg.stateHmacSecretEnv} on every gateway`,
      `   instance, then restart.`,
      ``,
      `MAINTENANCE WINDOW: any /alter connect link issued in the last 10 minutes will be`,
      `rejected after the restart with "state signature mismatch". Affected users re-run`,
      `/alter connect <provider> and complete OAuth again. Existing grants are unaffected.`,
      ``,
      `This command is informational only — actual key rotation is operator-driven via env`,
      `var change + gateway restart. SQLite has nothing to migrate; HMAC verification is`,
      `purely in-memory.`,
    ].join("\n") + "\n",
  );
  return 0;
}

function unlinkChannelUserAction(opts: {
  kind: string;
  userId: string;
  yes?: boolean;
  workspaceDir?: string;
}): number {
  const workspaceDir = resolveWorkspaceDir(opts);
  const db = openDatabase(workspaceDir);

  const link = db
    .prepare(
      `SELECT app_user_id, idp_sub FROM identity_link WHERE channel_kind = ? AND channel_user_id = ?`,
    )
    .get(opts.kind, opts.userId) as { app_user_id: string; idp_sub: string } | undefined;

  if (!link) {
    process.stderr.write(
      `[alter unlink-channel-user] no link found for ${opts.kind}/${opts.userId}\n`,
    );
    return 1;
  }

  const grants = db
    .prepare(`SELECT provider, grant_id FROM grants WHERE app_user_id = ?`)
    .all(link.app_user_id) as Array<{ provider: string; grant_id: string }>;

  process.stdout.write(
    `Will delete:\n` +
      `  link: ${opts.kind}/${opts.userId} → app_user=${link.app_user_id} (sub=${link.idp_sub})\n` +
      `  ${grants.length} local grant cache row(s):\n` +
      grants.map((g) => `    - ${g.provider} (${g.grant_id})\n`).join("") +
      `\nNOTE: this only clears the PLUGIN's local mapping. The OAuth grants in Alter Vault\n` +
      `are NOT revoked. Run /alter connections revoke <id> as the user (or use Alter's\n` +
      `admin tools) if you want to revoke the grants too.\n`,
  );

  if (!opts.yes) {
    process.stderr.write(`\nRe-run with --yes to actually delete.\n`);
    return 0;
  }

  const t = db.prepare(`DELETE FROM grants WHERE app_user_id = ?`);
  t.run(link.app_user_id);
  db.prepare(`DELETE FROM identity_link WHERE channel_kind = ? AND channel_user_id = ?`).run(
    opts.kind,
    opts.userId,
  );
  db.prepare(`DELETE FROM session_to_user WHERE app_user_id = ?`).run(link.app_user_id);
  process.stdout.write(`Deleted.\n`);
  return 0;
}

async function enableToolsAction(opts: {
  dryRun?: boolean;
  openclawBin?: string;
}): Promise<number> {
  const patch = { tools: { alsoAllow: [...TOOL_NAMES] } };
  const json = JSON.stringify(patch, null, 2);

  if (opts.dryRun) {
    process.stdout.write(
      `[alter enable-tools] dry run — would apply this patch to your openclaw config:\n\n${json}\n\n` +
      `Re-run without --dry-run to apply.\n`,
    );
    return 0;
  }

  process.stdout.write(
    `[alter enable-tools] adding ${TOOL_NAMES.length} alter tools to tools.alsoAllow…\n`,
  );

  // Resolve the `openclaw` binary path. Preference order:
  //   1. --openclaw-bin <path>           (operator-explicit, wins always)
  //   2. process.argv[1]                  (the openclaw binary that loaded us)
  //   3. "openclaw"                       (PATH lookup — last resort)
  // Preferring argv[1] over PATH avoids a footgun where an attacker-controlled
  // `openclaw` shim earlier in $PATH would shadow the real binary. We only
  // fall back to PATH if argv[1] doesn't look like an openclaw entrypoint
  // (e.g. running under `node -e`, ts-node REPL, etc.).
  const argv1 = process.argv[1] ?? "";
  const inferredBin =
    argv1 && /openclaw/i.test(argv1) ? argv1 : "openclaw";
  const bin = opts.openclawBin ?? inferredBin;

  return await new Promise<number>((resolve) => {
    const child = spawn(bin, ["config", "patch", "--stdin"], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", (err) => {
      process.stderr.write(
        `[alter enable-tools] failed to spawn '${bin} config patch': ${err.message}\n` +
        `Pass --openclaw-bin <path> to point at the right binary if PATH lookup is wrong.\n`,
      );
      resolve(2);
    });
    child.on("exit", (code) => {
      if (code === 0) {
        process.stdout.write(
          `[alter enable-tools] done. Restart the gateway to apply ` +
          `(launchctl kickstart -k gui/$UID/<service> or however you run it).\n`,
        );
      }
      resolve(code ?? 1);
    });
    child.stdin.end(json);
  });
}

export function buildCliRegistrar(deps: CliDeps): CliRegistrar {
  return (ctx) => {
    const root = ctx.program
      .command("alter")
      .description("Operator administration for the Alter Vault plugin");

    root
      .command("login")
      .description(
        "Drive the Alter IdP login flow from the terminal. Opens your browser to Alter's hosted sign-in page (your configured IdP), polls for completion, and stores the resulting JWT in the plugin's local identity table under (channel='local', user='operator') by default. Useful for testing the integration without setting up a real chat channel.",
      )
      .option("--channel <kind>", "Channel kind to bind the JWT under", "local")
      .option("--user <id>", "Channel-user id to bind the JWT under", "operator")
      .option(
        "--workspace-dir <path>",
        "Workspace dir (where .alter/plugin.sqlite lives). Defaults to cwd — pass the gateway's runtime dir to share its identity store.",
      )
      .action(async (...args: unknown[]) => {
        const opts = args[0] as { channel: string; user: string; workspaceDir?: string };
        process.exit(await loginAction(deps, opts));
      });

    root
      .command("db-rotate-key")
      .description(
        "Re-encrypt the identity store with a new AES-256-GCM key. The new 64-hex key is read from --new-key-env.",
      )
      .requiredOption(
        "--new-key-env <name>",
        "Env var name holding the new 64-hex (32-byte) AES key",
      )
      .option(
        "--workspace-dir <path>",
        "Workspace dir (where .alter/plugin.sqlite lives). Defaults to cwd.",
      )
      .action((...args: unknown[]) => {
        const opts = args[0] as { newKeyEnv: string; workspaceDir?: string };
        process.exit(dbRotateKeyAction(deps, opts));
      });

    root
      .command("rotate-state-hmac")
      .description(
        "Print the operator runbook for rotating OPENCLAW_ALTER_STATE_HMAC_SECRET (10-min connect-link window).",
      )
      .action(() => {
        process.exit(rotateStateHmacAction(deps));
      });

    root
      .command("enable-tools")
      .description(
        "Add every tool this plugin ships (read from its own registry) to your openclaw config's tools.alsoAllow. Run this once after install so the agent's tool profile actually exposes alter_* tools.",
      )
      .option("--dry-run", "Print the patch JSON instead of applying it")
      .option(
        "--openclaw-bin <path>",
        "Path to the openclaw binary. Defaults to argv[1] (the binary that loaded this plugin), then PATH.",
      )
      .action(async (...args: unknown[]) => {
        const opts = args[0] as { dryRun?: boolean; openclawBin?: string };
        process.exit(await enableToolsAction(opts));
      });

    root
      .command("unlink-channel-user")
      .description(
        "Delete a (channel_kind, channel_user_id) link and its local grant cache rows. Use when an IdP `sub` claim has changed.",
      )
      .requiredOption("--kind <channel>", "Channel kind (e.g. slack, telegram, webchat)")
      .requiredOption("--user-id <id>", "Channel-scoped user id (e.g. U042…)")
      .option("--yes", "Actually delete (default: dry-run)")
      .option(
        "--workspace-dir <path>",
        "Workspace dir (where .alter/plugin.sqlite lives). Defaults to cwd.",
      )
      .action((...args: unknown[]) => {
        const opts = args[0] as {
          kind: string;
          userId: string;
          yes?: boolean;
          workspaceDir?: string;
        };
        process.exit(unlinkChannelUserAction(opts));
      });
  };
}

export function registerCli(api: OpenClawPluginApi, deps: CliDeps): void {
  // `descriptors` is the parse-time contract OpenClaw's CLI uses to advertise
  // the top-level command at help time without invoking the registrar (lazy
  // loading). Bundled plugins (memory-core, etc.) use this form. The simpler
  // `commands: [...]` form did NOT make our subcommand visible to `openclaw
  // --dev alter ...`.
  api.registerCli(buildCliRegistrar(deps) as Parameters<OpenClawPluginApi["registerCli"]>[0], {
    descriptors: [
      {
        name: "alter",
        description:
          "Alter Vault plugin operator commands: login (terminal IdP sign-in), enable-tools, db-rotate-key, rotate-state-hmac, unlink-channel-user.",
        hasSubcommands: true,
      },
    ],
  });
}

// `randomBytes` is referenced for the runbook's example only; keep imports tidy.
void randomBytes;
