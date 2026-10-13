# Changelog

Notable changes to `@alter-ai/openclaw-plugin`. Each version's section here
becomes its GitHub release notes.

## 0.8.0

- **`pnpm dev`: run the plugin locally in seconds, with no accounts.** It
  builds the plugin and starts a real OpenClaw gateway with it linked from
  your checkout, state kept in `.dev/`. Unless `.env.dev` holds real Alter
  keys, the plugin talks to `dev/fake-alter.mjs`, a local stand-in for Alter
  whose sign-in, connect and approval links open small pages on your machine.
  Add an OpenAI key and Slack or Discord tokens to `.env.dev` (template:
  `.env.dev.example`) to chat with it. `pnpm dev -- --smoke` boots it, checks
  it and stops, in a throwaway state directory.
- **End-to-end tests** (`tests/e2e/`, `pnpm test:e2e`): the real plugin and
  the real Alter SDK against the fake Alter over HTTP, acting as chat users
  through sign-in, connecting and reconnecting a provider, reads,
  approval-gated writes, revoking, the daily usage cap, several people in DMs
  and in one shared channel, the same person on two chat platforms, and a
  gateway restart. `docs/DEVELOPMENT.md` describes them.
- `baseUrl`, `walletBaseUrl` and `publicBaseUrl` accept `http://` on
  `localhost`, `127.0.0.1` and `[::1]`, for a gateway on a developer's
  machine. Everything else still has to be `https://`, and the plugin now
  checks the exact pattern its manifest declares.
- In-flight sign-ins stop polling when the gateway stops and resume on the
  next boot, so a plugin instance that is shutting down never stores a
  sign-in after its replacement has taken over.
- The date and attendee parameters of the Google Calendar and Calendly tools
  now have length limits; `format` alone didn't bound them.
- Decrypting a stored sign-in requires the full-length AES-GCM tag.
- The reference Fly image pins its Node base image by digest, and
  `deploy/fly/smoke-test.sh` also checks that every tool in the manifest is
  visible to the agent and refuses callers who aren't chat users.
- CI pins pnpm to an exact version.

## 0.7.0

The plugin code is unchanged; this release is about deploying and adopting it.

- **Discord support in the reference Fly deployment.** Slack and Discord now
  each turn on from their secrets (`SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`,
  `DISCORD_BOT_TOKEN`): the next boot installs OpenClaw's plugin for the
  platform and enables it with team defaults. `deploy/fly/README.md` has
  step-by-step Slack and Discord setup and a post-deploy checklist, and
  `OPERATOR_SETUP.md` covers the same by hand for other hosts.
- **Deployment tests.** Unit tests for the entrypoint's config logic (now in
  `deploy/fly/config-reconcile.cjs`), and `deploy/fly/smoke-test.sh`, which
  boots the image in Docker for every chat setup; CI runs it on deployment
  changes.
- The README now explains what the plugin is for: why a shared agent needs
  per-person identity, how it works, exactly what is separate per person and
  what a conversation shares, and what your team can ask it to do.
- New `docs/USER_GUIDE.md`, a short guide to share with the people on your
  team.
- A written contribution policy in `CONTRIBUTING.md`: every pull request needs
  a maintainer's approval, and every commit needs a DCO sign-off
  (`git commit -s`).
- CI checks the DCO sign-off on pull requests.
- `.github/CODEOWNERS` names the maintainers team.

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
