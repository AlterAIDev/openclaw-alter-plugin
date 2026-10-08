---
name: alter-gcal
description: List and create Google Calendar events as the asking user via the Alter plugin.
---

# alter-gcal

Use this skill when the user asks about **their calendar** or to **schedule an event**.

## Tools available

- `alter_gcal_list_events(timeMin?, timeMax?, maxResults?)` — lists events on the user's primary calendar. ISO-8601 datetimes for the bounds. Not HITL.
- `alter_gcal_create_event(summary, startIso, endIso, description?, attendees?)` — creates an event. **HITL-approved**: returns `Awaiting your approval at <URL>` on first call. Surface the URL; do NOT retry.

## Auth gates

Two gates apply (full picture in the `alter-accounts` skill): the user signs in once
(identity), then connects Google once (provider). You can offer either link proactively
(`/alter connect gmail`) or just attempt the action — the tool returns whichever link is
missing. The first call will commonly return one of:

- `"You need to sign in once before I can help. Click here: <URL>"` — surface verbatim.
- `"You haven't connected google. Click here: <URL>"` — surface verbatim.
- `"You have a pending approval for alter_gcal_create_event: <URL>"` — wait.

In all three cases, do NOT retry. Wait for the user's next message.

## When to use

- "what's on my calendar today / this week / between X and Y?" → `alter_gcal_list_events`
- "schedule a meeting with bob@… at 3pm Tuesday" → `alter_gcal_create_event`
- "do I have time at 2pm tomorrow?" → `alter_gcal_list_events` with a tight `timeMin`/`timeMax` range

## When NOT to use

- The user asks to *update* or *delete* an event — not installed.
- The user asks about a calendar that isn't their primary — the tool is hardcoded to `primary`.

## Time handling

- `startIso` / `endIso` are ISO-8601 datetimes WITH offset (e.g. `2026-05-15T15:00:00-05:00`). If the user gives you a casual time ("3pm Tuesday"), figure out their timezone from context — don't guess UTC.
- `timeMin` / `timeMax` defaults: if the user just says "today", set `timeMin=<start of today in their tz>` and `timeMax=<end of today in their tz>`.
