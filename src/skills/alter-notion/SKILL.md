---
name: alter-notion
description: Search and create Notion pages as the asking user via the Alter plugin.
---

# alter-notion

Use this skill when the user asks to **find a Notion page** or **create a Notion page**.

## Tools available

- `alter_notion_search(query, pageSize?)` — full-text search across the user's connected Notion workspace. Returns pages and databases. Not HITL.
- `alter_notion_create_page(parentPageId, title, bodyMarkdown?)` — creates a page as a child of `parentPageId`. **HITL-approved**: first call returns an approval URL. Read the tool result and tell the user to approve in the wallet — don't keep retrying.

## Auth gates

Two gates apply (full picture in the `alter-accounts` skill): the user signs in once
(identity), then connects Notion once (provider). You can offer either link proactively
(`/alter connect notion`) or just attempt the action — the tool returns whichever link
is missing. The first call will commonly return one of:

- `"You need to sign in once before I can help. Click here: <URL>"` — surface verbatim.
- `"You haven't connected notion. Click here: <URL>"` — surface verbatim.
- `"You have a pending approval for alter_notion_create_page: <URL>"` — tell the user to resolve it (or `/alter status clear` if stale) before trying again.

In all three cases, do NOT call the tool a second time. Wait for the user's next message.

## When to use

- "find my Notion page about Q3 planning" → `alter_notion_search`
- "create a page under <id> titled 'Standup notes'" → `alter_notion_create_page`

## When NOT to use

- The user asks to update an existing page, change a database property, or delete — none of those tools are installed. Say so explicitly.
- The user asks to upload a file — not installed.
