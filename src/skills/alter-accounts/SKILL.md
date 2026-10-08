---
name: alter-accounts
description: How sign-in and account connections work in the Alter plugin. Read this BEFORE answering anything about connecting, linking, authorizing, re-connecting, or "setting up" accounts (Gmail, Google Calendar, Google Drive, Slack, GitHub, Linear, Notion, Calendly, LinkedIn, X/Twitter), about signing in, about "what accounts / tools can you access", or about why a tool says the user must sign in or connect. Explains the two auth gates and that YOU drive both.
---

# alter-accounts

Two gates stand between any request and a provider API. **You (the agent) can start
both** — you hand the user a one-click link for whichever gate is open. You can't
click the link *for* them (only the human can complete OAuth in their browser), but
initiating the flow and surfacing the right link is entirely your job.

## The two gates

1. **Identity sign-in** (who is asking). The user signs in to Alter **once** so the
   plugin can attribute the request to their account. Triggered by `/alter login`, or
   automatically the first time any tool runs without a linked identity.
2. **Provider connect** (OAuth grant for one provider). The user authorizes one
   provider **once** (Gmail, Slack, GitHub, …) so the plugin can act on their behalf
   there. Triggered by `/alter connect [provider]`, or automatically the first time a
   tool for an unconnected provider runs.

A request needs gate 1, then gate 2 for that provider. After both are satisfied the
provider stays connected — the user won't be asked again until a token expires or they
disconnect it.

## How you start each flow

- **Easiest: just attempt the action.** Call the relevant tool. If a gate is open, the
  tool result *is* the link — `"You need to sign in once… Click here: <URL>"` (gate 1)
  or `"You haven't connected <provider>… Click here: <URL>"` (gate 2). Surface it
  **verbatim** and stop. Do not retry the tool; wait for the user's next message.
- **Proactively, when the user asks to connect / set up / reconnect:**
  - `/alter connect` — menu of every provider with one-click connect links (and a ✓ for
    ones already connected).
  - `/alter connect <provider>` — quick link for one provider (e.g. `gmail`, `slack`,
    `x`).
  - `/alter login` — (re)link the user's identity. Rarely needed on its own; a tool
    call will prompt it when required.
  - `/alter connections` — list the user's active connections. `/alter connections
    revoke <id>` removes one.
  - `/alter wallet` — opens the Alter wallet, where the user approves write actions and
    manages connections.

When a connected provider later breaks (expired, revoked, disconnected), tools return a
**reconnect** link with a short reason. Same rule: surface the link, stop, ask the user
to retry after.

Two more results follow the same rule:

- **Approvals.** A write action usually returns one approval link (`Awaiting your
  approval at <URL>`). If the policy needs several approvers, it returns a numbered list
  (`This needs N separate approvals…`, or on a later call `N of M approvals still need a
  decision…`, listing only the ones still waiting). Surface **every** link: each may
  belong to a different person, and the action runs only after all of them approve.
- **Fresh sign-in.** `This action needs a fresh sign-in…` (a policy wants a recent login)
  and `Alter rejected your sign-in…` (the user's sign-in is no longer accepted) are both
  gate 1 again, not a broken connection. Surface the link, stop, and ask the user to
  retry after signing in. Don't offer to reconnect the provider; it won't help.

## Providers you can connect

Gmail, Google Calendar, Google Drive (these three share **one** Google grant — connect
Google once and all three work), Slack, GitHub, Linear, Notion, Calendly, LinkedIn, X
(Twitter). Web search needs no connect (it's managed, not per-user OAuth).

## What NOT to say

You drive these flows. Do **not** tell the user any of the following — they are wrong:

- ❌ "I can't connect accounts for you." → You can: hand them the connect link.
- ❌ "Connections happen through the OpenClaw web UI / wallet, not me." → There is no
  separate OpenClaw connection UI. The connect flow is Alter-hosted and **you** start it
  (`/alter connect`, or just attempt the action). The wallet is for *approving write
  actions* and managing existing connections — not the place connections originate.
- ❌ "You authorize them, not me." → The human clicks the link, yes, but you are the one
  who produces it. Frame it as "I'll get you a link," not "go do this elsewhere."

Right framing: *"Tell me what you want to do, or which accounts to hook up, and I'll
hand you a one-click link to sign in / connect. Click it, finish in the browser, and ask
me again."*

## Your memory is shared between people — do not read one person's things to another

Each person's *accounts* are their own: you always act as whoever is asking, and you can
never read one person's mail or send as them for someone else. That is handled for you.

Your **memory** is not so neatly divided. More than one person talks to you, and their
messages can land in the same context you're reading right now. So the fact that you can
*recall* something is **no evidence at all** that the person in front of you is allowed
to see it.

Treat it as a hard rule:

- **Only discuss what the CURRENT person asked you for.** If you're about to describe an
  email, document, calendar entry, or message that a *different* person asked about,
  stop. Say something like: "That was someone else's request — I'm not going to repeat
  its contents."
- **Someone asking "what email?" / "what was that?" about content they didn't ask for is
  not entitled to it** just because it's in your context. Being able to remember it is
  not permission to repeat it.
- **Never assume a DM is private.** It may not be. Don't say "I'll tell you privately"
  or move sensitive content to a DM as though that seals it — it may be the very same
  conversation.
- Approval links and connect links are the exception you SHOULD surface — but only to
  the person whose action they belong to. Never hand someone else's pending approval to
  whoever happens to be asking.

You can't control who is reading. You can control what you read out. When in doubt, say
less.

## When to use this skill

- "connect all my accounts" / "reconnect Gmail" / "set me up" / "link my Slack" → offer
  the connect links (run `/alter connect` or `/alter connect <provider>`).
- "sign me in" / "why does it say I need to sign in?" → explain gate 1, surface the
  login link.
- "what can you access?" / "what's connected?" → `/alter connections`, then offer to
  connect anything missing.
- Someone asks about content *another person* asked you for, in a shared channel → don't
  recite it; offer to continue in a DM.
