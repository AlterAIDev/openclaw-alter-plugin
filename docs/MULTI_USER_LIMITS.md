# Multi-user limits: what this plugin isolates, and what it cannot

> ## ⚠️ Set `session.dmScope` before a second person can DM the bot
>
> OpenClaw's `session.dmScope` defaults to `"main"`: **all DMs share one
> session.** On a gateway left at the default, `openclaw sessions list` shows a
> single `direct` session for the whole deployment:
>
> ```
> $ openclaw sessions list
> Kind     Key                Age      Tokens (ctx %)
> direct   agent:main:main    29m ago  …
> ```
>
> Every user's DM with the bot lands in it. Two people DMing the bot are not in
> two conversations; they are in the *same* conversation, and each can ask the
> bot to read back what the other said. The fix is one line of config:
>
> ```json
> "session": { "dmScope": "per-channel-peer" }
> ```
>
> The reference template (`deploy/fly/openclaw.json.template`) sets it. If you
> run a gateway that does not use the template, set it yourself — and if the
> gateway has already been running without it, follow
> [Migrating a gateway that ran without `dmScope`](#migrating-a-gateway-that-ran-without-dmscope).

## The one-line rule

> **A session is not a person.** This plugin enforces per-user *actions*.
> Per-user *privacy* of the conversation depends on how OpenClaw scopes
> sessions, and in a shared channel it does not exist.

## What IS isolated per user

Enforced per *invoking user*, resolved from a sealed identity link, on every
call:

- **Alter identity.** `identity_link` PK `(channel_kind, channel_user_id)`. Each
  chat user → their own `app_user_id` and sealed JWT.
- **OAuth grants.** Keyed `(app_user_id, provider)`. User B cannot reach user A's
  Gmail grant.
- **Approvals.** A wallet approval belongs to whoever triggered it; only they can
  approve it. The local lock is keyed `(session_id, app_user_id)` — see
  [Why the approval lock is keyed per user](#why-the-approval-lock-is-keyed-per-user).
- **Usage quota.** Per `app_user_id`, per UTC day.
- **Memory** (`alter_memory_*`). Partitioned by `alter:user:<app_user_id>`,
  resolved from the user's JWT by Alter — **not** by session, and not by the
  plugin's local `idp:<sub>`. This is the one store that must use Alter's
  canonical id: a raw IDP sub isn't stable across an IdP migration, so memory
  keyed on it would orphan (or, on a reused sub, inherit someone else's). Fails
  closed — if Alter can't verify the identity, nothing is read or written. See
  `src/memory/scope.ts`.

> **Note on OpenClaw's own memory.** `memory-core` ships enabled and its memory
> is **agent-scoped, not user-scoped** — its docs say plainly that "no privacy
> boundary exists between different users DMing the same agent", and its default
> recall policy allows `chatType: "direct"`. **Do not enable OpenClaw's memory
> search on defaults** in a multi-user deployment — it would re-open, through
> the memory layer, the leak `dmScope` closes, and `dmScope` would not save you
> because that memory isn't keyed by session at all. Use the `alter_memory_*`
> tools instead: same feature, partitioned on verified identity.

**So user B cannot act as user A** — cannot read their mail, send as them, or
approve their writes — whatever the session layout.

## What is NOT isolated

### The conversation transcript

The agent's context is the whole session. In a shared session — a channel, a
group DM, or every DM on a gateway without `dmScope` — that context is **every
participant's messages and every reply to any of them**.

If user A asks for an email draft, it is in the transcript. If user B then asks
"what email?", the model answers from context. **No tool call happens, so no gate
can fire** — nothing is being *fetched*, it is being *recalled*. The plugin is
never consulted and cannot intervene.

This is not fixable in the plugin. It does not own the session key, does not
assemble the transcript, and is not called. Alter's [identity-propagation-to-memory
guide][mem] does not apply either: it partitions *memory layers* (Mem0/Zep/
LangGraph) by verified identity, and this transcript is not one — it is the raw
message history the gateway sends to the model. Alter cannot scope what it never
sees.

### `session.dmScope`

This is documented OpenClaw behaviour, not a bug. DMs collapse to the agent's
main session **by default**:

| `session.dmScope` | Behaviour |
|---|---|
| **`main`** (default) | **All DMs share one session** |
| `per-peer` | Isolate by sender, across channels |
| **`per-channel-peer`** | **Isolate by channel + sender — recommended, and what the reference template sets** |
| `per-account-channel-peer` | Isolate by account + channel + sender |

The OpenClaw docs describe this exact failure. From
[concepts/session][ocsession], "DM isolation" (Warning box), verbatim:

> "Without it, all users share the same conversation context, so Alice's private
> messages would be visible to Bob."

And from [gateway/security][ocsecurity], verbatim:

> "By default, OpenClaw routes all DMs into the main session for cross-device
> continuity. If multiple people can DM the bot (open DMs or a multi-person
> allowlist), isolate DM sessions: `session.dmScope: "per-channel-peer"`"

> "Treat `dmPolicy="open"` and `groupPolicy="open"` as last-resort settings;
> prefer pairing + allowlists unless you fully trust every member of the room."

The reference template runs `dmPolicy: "open"` + `allowFrom: ["*"]`, which is
precisely the condition the first quote warns about, so it also sets:

```json
"session": { "dmScope": "per-channel-peer" }
```

Two things this does **not** do:

1. **It does not retroactively split an existing session.** `dmScope` scopes NEW
   sessions; see the migration steps below.
2. **It is a messaging-context boundary, not a host-admin boundary** (per the
   OpenClaw docs). Mutually adversarial users need separate gateways, not config.
   For members of one team sharing a deployment, this boundary is the right tool.

### Anything the agent says out loud

The bot replies into the conversation. Per-user gating decides **what the agent
may do**; it cannot decide **who is reading**.

## Why the approval lock is keyed per user

When a write needs approval, the plugin records a pending-approval lock so the
next call in that conversation can point the user back at their wallet link.

A lock keyed on `session_id` alone would leak: in a Slack group DM — one session
shared by everyone in it — a second participant asking the bot anything would be
handed the first participant's wallet URL and the name of the tool they were
running, even without ever signing in. So the lock is keyed
`(session_id, app_user_id)`, and the tool wrapper resolves identity **before**
consulting it. `tests/approval-lock-cross-user.test.ts` and
`tests/tool-approval-leak.test.ts` pin both halves.

This does not make a shared session private: anything the bot *said* about the
approval is still in the shared transcript.

## Guidance for operators

- **Set `session.dmScope: "per-channel-peer"`** on any gateway a second person
  can DM. The reference template does.
- **Shared channels remain shared** regardless — one room, one transcript, by
  design. Don't put anything into the bot in a channel that you wouldn't post in
  that channel yourself.
- **Treat open DM and group policies as last-resort settings.** Prefer pairing +
  allowlists unless you trust every member of the workspace.
- **Per-user actions are safe either way.** Grants, approvals, quotas and memory
  are partitioned on verified identity, not on the session.

### Migrating a gateway that ran without `dmScope`

If a gateway has been running with the default, its `agent:main:main` session
already holds every user's accumulated DM history, and setting `dmScope` does not
retire it. To fix, in order:

1. **Deploy the `session.dmScope: "per-channel-peer"` config.** New DMs then get
   their own session per sender.
2. **Delete the existing shared session.** There is **no**
   `openclaw sessions delete` subcommand (the `sessions` verbs are `list`,
   `cleanup`, `compact`, `export-trajectory`, `tail`), and
   `sessions cleanup --fix-dm-scope` does **not** retire the main session.
   Instead: remove the `agent:main:main` entry from
   `<state-dir>/agents/main/sessions/sessions.json`, delete its
   `<sessionId>.*` transcript files, then restart the gateway so it reloads from
   the cleaned store rather than rewriting its in-memory copy. Skipping this
   leaves the old shared history reachable.
3. **Verify.** `openclaw sessions list` should show only per-user sessions such
   as `agent:main:slack:direct:<userid>`. 1:1 DMs are then genuinely isolated and
   become the right place for anything sensitive.

[mem]: https://docs.alterauth.com/guides/propagate-identity-to-memory

[ocsession]: https://docs.openclaw.ai/concepts/session
[ocsecurity]: https://docs.openclaw.ai/gateway/security
