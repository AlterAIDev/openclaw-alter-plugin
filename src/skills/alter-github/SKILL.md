---
name: alter-github
description: Search GitHub issues/PRs and create issues/comments as the asking user via the Alter plugin.
---

# alter-github

Use this skill when the user asks to **search GitHub issues/PRs**, **open an issue**, or **comment on an issue/PR**.

## Tools available

- `alter_github_search_issues(q, perPage?)` — uses GitHub search syntax (e.g. `repo:foo/bar is:open label:bug "deploy"`). Returns issues and pull requests. Not HITL.
- `alter_github_create_issue(owner, repo, title, body?, labels?)` — opens an issue in `owner/repo`. **HITL-approved**.
- `alter_github_create_comment(owner, repo, issueNumber, body)` — comments on issue or PR. **HITL-approved**.

## Auth gates

Two gates apply (full picture in the `alter-accounts` skill): the user signs in once
(identity), then connects GitHub once (provider). You can offer either link proactively
(`/alter connect github`) or just attempt the action — the tool returns whichever link
is missing. First call may return:

- `"You need to sign in once before I can help. Click here: <URL>"` — surface verbatim.
- `"You haven't connected github. Click here: <URL>"` — surface verbatim.
- `"You have a pending approval for alter_github_…: <URL>"` — user resolves in wallet.

Do NOT retry on these.

## When to use

- "find open issues about flaky tests in monorepo" → `alter_github_search_issues` with `q: "repo:org/monorepo is:open is:issue flaky"`
- "open a bug against acme/widgets titled 'X breaks Y'" → `alter_github_create_issue`
- "comment on acme/widgets#42: 'fixed in PR #43'" → `alter_github_create_comment`

## When NOT to use

- The user asks to merge a PR, change labels on an existing issue, close an issue, or manage releases — none installed.
- The user asks to read the full body of an issue — `search_issues` returns titles/snippets, not full bodies. Say you'd need a separate "get issue" tool.
