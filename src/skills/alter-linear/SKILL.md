---
name: alter-linear
description: Search and create Linear issues as the asking user via the Alter plugin.
---

# alter-linear

Use this skill when the user asks to **find a Linear issue** or **create a Linear issue**.

## Tools available

- `alter_linear_search_issues(query, first?)` — full-text search across the user's Linear workspace. Returns `{id, identifier, title, url, state, assignee, team}` per issue. Not HITL.
- `alter_linear_create_issue(teamId, title, description?)` — creates an issue in a team. **HITL-approved**. `teamId` is the Linear team **UUID**, not the team key (e.g. not `ENG`). Use `alter_linear_search_issues` first if the user only knows the team key — the returned `team` block contains both.

## Auth gates

Two gates apply (full picture in the `alter-accounts` skill): the user signs in once
(identity), then connects Linear once (provider). You can offer either link proactively
(`/alter connect linear`) or just attempt the action — the tool returns whichever link
is missing. First call may return:

- `"You need to sign in once before I can help. Click here: <URL>"` — surface verbatim.
- `"You haven't connected linear. Click here: <URL>"` — surface verbatim.
- `"You have a pending approval for alter_linear_create_issue: <URL>"` — user resolves in wallet.

Do NOT retry on these.

## When to use

- "find Linear issues about onboarding" → `alter_linear_search_issues`
- "create a Linear issue in the platform team: 'Investigate flaky CI'" → first search for an issue in that team to grab the `teamId`, then `alter_linear_create_issue`

## When NOT to use

- The user asks to change status, assign, comment, or close — none installed.
- The user gives a team **key** (e.g. `ENG-123`) and no other context — clarify; you need the team UUID for create.
