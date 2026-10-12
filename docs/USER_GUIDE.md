# Using the Alter assistant

A short guide for the people on a team whose OpenClaw agent runs the Alter
plugin. Operators: share this when you roll the agent out.

## What it does for you

The assistant works in **your own accounts, as you**: it reads your mail,
calendar and documents, and drafts and sends things on your behalf. It never
acts as anyone else, and nobody else can use your accounts through it.

| Account | Ask things like |
|---|---|
| Gmail | "find the contract email from Acme and summarize it" · "tell Dana the review moved to 3pm" |
| Google Calendar | "what's on my calendar tomorrow?" · "book 30 minutes with Carol on Friday" |
| Google Drive | "find the latest budget spreadsheet" |
| Slack | "what did people say about the launch in #eng?" · "post the standup summary to #team" |
| GitHub | "open bugs in acme/widgets" · "file an issue for the login crash" |
| Linear | "what are my open Linear issues?" · "create an issue for the flaky test" |
| Notion | "find the onboarding doc" · "add a page under Meeting Notes" |
| Calendly | "who booked time with me this week?" · "send a link for a 30-minute call" |
| LinkedIn, X | "show my recent posts" · "share this announcement" |
| The web | "search the web for the latest OpenClaw release" |
| Memory | "remember that I prefer short answers" · "what do you remember about me?" |

Which of these you can use depends on what your administrator has turned on.

## Getting started

1. **Just ask for something**, for example "what's on my calendar today?"
2. **The first time, sign in.** The assistant replies with a one-time link
   (it expires in 10 minutes). Open it and sign in with your work account on
   Alter's page, then come back and ask again.
3. **Connect the account it needs.** If the request needs an account you
   haven't connected, the assistant replies with a connect link for it.
   Approve access on that service's own screen, then ask again. One Google
   connection covers Gmail, Calendar and Drive.

From then on, just ask. Type `/alter connect` any time for a menu of connect
links.

**In a shared Slack or Discord channel, @mention the assistant** so it knows
you're talking to it (in Discord server channels it only answers when
mentioned). In Discord, replies to `/alter` commands are visible only to you.

## Approving actions

Anything that **sends, posts, creates or cancels** waits for you:

1. The assistant replies "Awaiting your approval" with a link to your
   **Alter Wallet**.
2. Open it, check what's about to happen, and approve or deny.
3. Ask the assistant again to get the result.

Some actions need more than one approver, such as a manager your
organization's policy names; the assistant lists every link, and the action
runs once all of them approve. **Nobody else in the conversation can approve
your requests or see your approval links.**

While an approval is pending, the assistant answers your other requests in
that conversation with the pending link until you approve or deny it. If one
gets stuck, type `/alter status clear`.

## Who can see what

- **Your connected accounts are yours alone.** Nobody else's requests can use
  them, and you can't use theirs.
- **In a channel or group DM, everyone there sees what you ask and what the
  assistant answers.** If you ask for your calendar in `#team`, `#team` sees
  it. Ask about anything private in a direct message.
- **Direct messages are your own conversation**, as long as your administrator
  has set the agent up with one session per person (the standard setup does).
- **Memory is yours.** The assistant can save things it learns about you to
  help later, like a preference or a project you keep mentioning. Nobody
  else's requests can read it. Ask "what do you remember about me?" any time,
  and say "forget that" or "forget everything" to delete it.
- **Your Alter Wallet shows everything the assistant did as you.** Open it with
  `/alter wallet`.

## Managing your connections

| Command | Does |
|---|---|
| `/alter connections` | List the accounts you've connected |
| `/alter connections revoke <id>` | Disconnect one (you can also do this in your Wallet) |
| `/alter connect <provider>` | Connect or reconnect one, e.g. `/alter connect gmail` |
| `/alter wallet` | Open your Alter Wallet |
| `/alter status` | See whether you're signed in and anything pending |
| `/alter status clear` | Clear a stuck pending approval |
| `/alter login` | Sign in again manually (rarely needed) |

## If something goes wrong

| The assistant says | What it means | What to do |
|---|---|---|
| A sign-in link, again | Your sign-in expired | Sign in again; it's the same quick flow |
| A connect link for an account you already connected | That connection was revoked or expired | Reconnect it |
| "You have a pending approval" | An earlier request is still waiting for you | Approve or deny it in your Wallet, or `/alter status clear` if it's stuck |
| "Action blocked by policy" | Your organization's rules don't allow this action | Ask your administrator |
| "You've reached today's usage cap" | You've hit your daily limit | Try again tomorrow, or ask your administrator |
| "Your Alter identity has been deprovisioned" (or suspended) | Your account was turned off | Only an administrator can restore it |
| "This assistant's Alter API key is missing a permission" | A setup problem on the administrator's side | Tell your administrator; retrying won't help |
