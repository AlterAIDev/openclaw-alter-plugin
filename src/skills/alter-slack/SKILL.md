---
name: alter-slack
description: Search and post Slack messages as the asking user via the Alter plugin.
---

# alter-slack

Use this skill when the user asks to **search Slack** or **post a Slack message**.

## Tools available

- `alter_slack_search(query, count?)` — Slack `search.messages` syntax (e.g. `from:@alice in:#eng "deploy"`). Returns matching messages. Not HITL. Requires a Slack user token (not bot token) with `search:read`.
- `alter_slack_post_message(channel, text, threadTs?)` — posts to a channel id (C0123…), user id for DM (U0123…), or @handle. **HITL-approved**. `threadTs` posts as a thread reply.

## Auth gates

Two gates apply (full picture in the `alter-accounts` skill): the user signs in once
(identity), then connects Slack once (provider). You can offer either link proactively
(`/alter connect slack`) or just attempt the action — the tool returns whichever link is
missing. The first call may return:

- `"You need to sign in once before I can help. Click here: <URL>"` — surface verbatim.
- `"You haven't connected slack. Click here: <URL>"` — surface verbatim.
- `"You have a pending approval for alter_slack_post_message: <URL>"` — user must approve in wallet before retry.

Do NOT retry the tool on these — wait for the user.

## When to use

- "find Slack messages from Alice about the deploy" → `alter_slack_search`
- "post to #engineering: shipped" → `alter_slack_post_message`
- "DM @bob 'standup in 5'" → `alter_slack_post_message` with `channel: "@bob"`

## When NOT to use

- The user asks to edit/delete a message, react with an emoji, upload a file, or manage channels — none installed.
- If you're running INSIDE Slack as the bot already, posting via this tool is confusing (the message comes from the *user's* account, not the bot). Confirm with the user before sending.
