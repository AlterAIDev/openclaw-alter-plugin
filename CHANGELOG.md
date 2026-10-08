# Changelog

Notable changes to `@alter-ai/openclaw-plugin`. Each version's section here
becomes its GitHub release notes.

## 0.6.0

First public release.

- Multi-user identity for OpenClaw: each chat user signs in through your IdP
  and is linked to their own Alter user.
- 29 provider tools (Gmail, Google Calendar, Google Drive, Slack, GitHub,
  Linear, Notion, Calendly, LinkedIn, X, web search) and 3 per-user memory
  tools, each called as the asking user through Alter Vault.
- Human-in-the-loop approval in the Alter Wallet for every write.
- Per-user daily token quotas, encrypted identity storage and HMAC-signed
  Connect state.
- A reference Fly.io deployment with Slack Socket Mode (`deploy/fly/`).
