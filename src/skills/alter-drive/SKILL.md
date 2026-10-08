---
name: alter-drive
description: Search and fetch metadata for Google Drive files as the asking user via the Alter plugin.
---

# alter-drive

Use this skill when the user asks to **find a file in Google Drive** or **get details about a Drive file**.

## Tools available

- `alter_drive_search(q, pageSize?)` — Drive v3 query syntax (e.g. `name contains 'budget' and mimeType='application/pdf'`). Returns `{id, name, mimeType, modifiedTime, webViewLink}` per file. Not HITL.
- `alter_drive_get_file(fileId)` — returns metadata for one file (size, owners, link). Not HITL. Does NOT download content.

Both reuse the user's existing **google** OAuth grant — same one used by `alter-gmail` / `alter-gcal`. No separate `/alter connect`.

## Auth gates

Two gates apply (full picture in the `alter-accounts` skill): the user signs in once
(identity), then connects Google once (provider — shared with Gmail/Calendar, so no
separate Drive connect). You can offer the link proactively (`/alter connect gmail`) or
just attempt the action — the tool returns whichever link is missing. First call may
return:

- `"You need to sign in once before I can help. Click here: <URL>"` — surface verbatim.
- `"You haven't connected google. Click here: <URL>"` — surface verbatim. (Drive scope must be in the operator's google provider config in Alter.)

Do NOT retry on these.

## When to use

- "find my Q3 budget PDF in Drive" → `alter_drive_search` with `q: "name contains 'Q3 budget' and mimeType='application/pdf'"`
- "what's the link for file id abc123" → `alter_drive_get_file`

## When NOT to use

- The user asks to read the *contents* of a Google Doc / Sheet — these tools return metadata only. Say a separate "export file content" tool would be needed.
- The user asks to upload, share, or delete — not installed.
