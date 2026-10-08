---
name: alter-gmail
description: Send and search Gmail as the asking user via the Alter plugin.
---

# alter-gmail

Use this skill when the user asks to **send an email** or **search their inbox**.

## Tools available

- `alter_gmail_send(to, subject, body)` — sends an RFC-822 email *as the asking user*. **HITL-approved**: returns `Awaiting your approval at https://wallet.alterauth.com/...` on first call. The user has to click the URL and approve in their wallet before the send fires. Don't keep retrying — read the tool result and tell the user to approve.
- `alter_gmail_search(query, maxResults?)` — Gmail-search-syntax query. Returns message **stubs only** (id + threadId — no subject, no sender, no body). Not HITL. ALWAYS pair with `alter_gmail_get_message` for any id you want to actually read.
- `alter_gmail_get_message(id, format?)` — fetches one message. `format="metadata"` (default) returns headers (Subject/From/To/Date) + snippet, no body — cheap. `format="full"` returns body parts (base64). Not HITL.

## Auth gates

Two gates apply (full picture in the `alter-accounts` skill): the user signs in once
(identity), then connects Google once (provider). You can offer either link proactively
(`/alter connect gmail`) or just attempt the action — the tool returns whichever link is
missing. The first call will commonly return one of:

- `"You need to sign in once before I can help. Click here: <URL>"` — surface the URL verbatim. Don't paraphrase or invent a new one.
- `"You haven't connected google. Click here: <URL>"` — same: surface verbatim.
- `"You have a pending approval for alter_gmail_send: <URL>"` — the user has a HITL prompt waiting on a previous call. Tell them to resolve it (or `/alter status clear` if stale) before trying again.

In all three cases, do NOT call the tool a second time. Wait for the user's next message.

## When to use

- "send an email to alice@…" → `alter_gmail_send`
- "find emails from bob about Q3 budget" → `alter_gmail_search`, then `alter_gmail_get_message` on the top few ids to show the user real subjects/senders
- "what's in my inbox today?" → `alter_gmail_search` with `query: "newer_than:1d"`, then expand ids with `alter_gmail_get_message`
- "what does the email from acme say?" → search first to find the id, then `alter_gmail_get_message` with `format: "full"`

## When NOT to use

- The user asks to delete / archive / mark-as-read — not installed.
- The user asks to download attachments — not installed (`get_message` returns inline parts only, no attachment fetch).
