# @alter-ai/openclaw-plugin

**One OpenClaw agent for your whole team, where everyone acts as themselves.**

Put one [OpenClaw](https://github.com/openclaw/openclaw) agent in Slack or
Discord. When Alice asks it to send an email, it sends from Alice's Gmail,
after Alice approves it. When Bob asks for his calendar, he gets his own. The
agent never holds anyone's passwords or tokens: [Alter](https://alterauth.com)
does.

## Get started

You need an OpenClaw gateway (or the Fly.io deployment in this repo), Node 22
or newer, and about 30 minutes.

### 1. Create a free Alter account

Sign up at **[portal.alterauth.com/sign-up](https://portal.alterauth.com/sign-up)**.
The free plan covers everything this plugin needs. No credit card.

### 2. Create an app and two API keys

In the portal, create an **App** (call it "OpenClaw"). Then, under
**API Keys**, mint two keys from that app with these scopes:

| Key | Scopes |
|---|---|
| **App key** (`alter_rk_…`) | `idp_users:write`, `idp_users:read`, `grants:read`, `grants:admin` |
| **Agent key** (`alter_ak_…`) | `proxy:execute`, `grants:read`, `grants:write`, `connect:initiate`, `identity:resolve` |

Copy both keys now. Each one is shown once.

### 3. Connect your identity provider

This is how your team signs in to the agent. On the app's **Identity** page,
add your provider (Okta, Auth0, Clerk, WorkOS, or any OIDC provider) and
register the two callback URLs the portal shows with it. The
[identity provider guide](https://docs.alterauth.com/admin/identity-provider)
walks through each one.

Do this before anyone signs in. Claim mappings lock after the first user.

### 4. Turn on the accounts your team will use

On the app's **OAuth** page, add the providers you want: Google (Gmail,
Calendar, Drive), Slack, GitHub, Linear, Notion, Calendly, LinkedIn, X. Most
offer **managed credentials**, so there is nothing to set up in the
provider's console.

Then add a runtime policy on each provider that **requires approval** for
writes (send, post, create, cancel). This is what makes the agent wait for the
person who asked before it acts.

Optional: for web search, add a **Managed Secret** for `tavily` with a key
from [app.tavily.com](https://app.tavily.com).

### 5. Install the plugin

Pick one:

- **Fly.io (fastest).** Follow [deploy/fly/README.md](./deploy/fly/README.md).
  It deploys the gateway with this plugin preinstalled and configured.
- **Your own OpenClaw gateway.**

  ```sh
  openclaw plugins install @alter-ai/openclaw-plugin
  openclaw alter enable-tools
  ```

  Set these on the gateway host:

  ```sh
  OPENCLAW_ALTER_APP_API_KEY=alter_rk_...            # from step 2
  OPENCLAW_ALTER_AGENT_API_KEY=alter_ak_...          # from step 2
  OPENCLAW_ALTER_DB_KEY=$(openssl rand -hex 32)
  OPENCLAW_ALTER_STATE_HMAC_SECRET=$(openssl rand -hex 32)
  ```

  And in the plugin config:

  ```json
  {
    "alter": {
      "publicBaseUrl": "https://openclaw.acme.example",
      "channelHashSalt": "<openssl rand -hex 32>"
    }
  }
  ```

  If your app lists allowed Connect return URLs, add
  `https://<publicBaseUrl>/alter/connect/cb`.

[OPERATOR_SETUP.md](./OPERATOR_SETUP.md) has every option and a
troubleshooting table.

### 6. Add it to Slack or Discord

| Platform | Secrets | Guide |
|---|---|---|
| Slack | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | [Slack setup](./deploy/fly/README.md#phase-2a--slack-socket-mode) |
| Discord | `DISCORD_BOT_TOKEN` | [Discord setup](./deploy/fly/README.md#phase-2b--discord) |

Not on Fly? [OPERATOR_SETUP.md step 9](./OPERATOR_SETUP.md#step-9--connect-slack-or-discord)
does the same by hand.

### 7. Try it

In Slack or Discord, ask the agent:

> what's on my calendar today?

It replies with a sign-in link, then a link to connect Google. Open both,
ask again, and you get your own calendar. Now ask it to email someone: it
waits until you approve in your [Alter Wallet](https://wallet.alterauth.com).

That's it. Share [docs/USER_GUIDE.md](./docs/USER_GUIDE.md) with your team.

## What your team can ask

Everyone uses their own connected accounts. Reads run straight away; writes
wait for approval.

| Provider | Ask things like |
|---|---|
| Gmail | "find the contract email from Acme and summarize it" · "tell Dana the review moved to 3pm" |
| Google Calendar | "what's on my calendar tomorrow?" · "book 30 minutes with Carol on Friday" |
| Google Drive | "find the latest budget spreadsheet" |
| Slack | "what did people say about the launch in #eng?" · "post the standup summary to #team" |
| GitHub | "open bugs in acme/widgets" · "file an issue for the login crash" |
| Linear | "what are my open Linear issues?" · "create an issue for the flaky test" |
| Notion | "find the onboarding doc" · "add a page under Meeting Notes" |
| Calendly | "who booked time with me this week?" · "cancel tomorrow's 2pm" |
| LinkedIn | "show my recent posts" · "share this announcement" |
| X | "show my latest posts" · "post this update" |
| Web search | "search the web for the latest OpenClaw release" |
| Memory | "remember that I prefer short answers" · "forget that" |

The agent offers sign-in and connect links when they're needed, so slash
commands are optional:

| Command | Does |
|---|---|
| `/alter connect [provider]` | Connect an account |
| `/alter connections` | List your connections (`revoke <id>` to remove one) |
| `/alter wallet` | Open your activity log, connections and approvals |
| `/alter status` | Show your sign-in state and any pending approval (`clear` to reset a stuck one) |

## Why we built this

A shared agent usually runs on one set of credentials. Everyone in the
channel reads and sends as whoever set it up, nothing waits for approval, and
removing one person means rotating the key for everyone.

With Alter, each person signs in with your identity provider and connects
their own accounts. On every request the agent acts as the person who asked:

- **Their accounts.** Bob's requests can never reach Alice's Gmail.
- **Their approval.** A write waits for the requester (plus anyone your
  policy adds), never for whoever else is in the channel.
- **No tokens on the gateway.** Alter holds the credentials and makes the
  call.
- **Their own audit trail**, daily token cap and memory.
- **Clean offboarding.** Deprovision someone in your identity provider and
  their next request is refused.

What is still shared: anything said in a channel, including the agent's
replies. Private requests belong in a DM. See
[docs/MULTI_USER_LIMITS.md](./docs/MULTI_USER_LIMITS.md).

## Security

Identity tokens are encrypted at rest, Connect links are signed and bound to
one user, and each person's approvals are locked to them. Report
vulnerabilities through [SECURITY.md](./SECURITY.md), not a public issue.

## Contributing

```sh
pnpm install
pnpm dev     # a real OpenClaw gateway with this plugin, no accounts needed
pnpm test
```

See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md) and
[CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT.
