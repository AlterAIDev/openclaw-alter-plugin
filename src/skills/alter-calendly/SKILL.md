---
name: alter-calendly
description: Inspect the user's Calendly account, list event types and scheduled events, generate scheduling links, and cancel bookings via the Alter plugin.
---

# alter-calendly

Use this skill when the user asks about their **Calendly** account: their meeting types, upcoming or past bookings, invitees, scheduling links to share, or cancelling an existing booking.

## Tools available

- `alter_calendly_get_current_user()` — returns the authenticated Calendly user, including `uri` (user URI) and `current_organization` URI. Call first; other tools need the user URI.
- `alter_calendly_list_event_types(userUri, active?, count?)` — lists the user's bookable meeting templates (their public scheduling URLs live on `scheduling_url`).
- `alter_calendly_list_scheduled_events(userUri, minStartTime?, maxStartTime?, status?, count?)` — lists scheduled events (bookings) for the user. ISO-8601 datetimes for the bounds; `status` is `active` or `canceled`.
- `alter_calendly_list_event_invitees(eventUuid, status?, count?)` — lists invitees on a given scheduled event. `eventUuid` is the last path segment of an event URI.
- `alter_calendly_create_scheduling_link(eventTypeUri, maxEventCount?)` — generates a single-use (default 1) booking link for a given event type. **HITL-approved**: returns `Awaiting your approval at <URL>` on first call. Surface the URL; do NOT retry.
- `alter_calendly_cancel_event(eventUuid, reason?)` — cancels a scheduled event. Calendly notifies invitees. **HITL-approved**: same pattern.

## Auth gates

Two gates apply (full picture in the `alter-accounts` skill): the user signs in once
(identity), then connects Calendly once (provider). You can offer either link
proactively (`/alter connect calendly`) or just attempt the action — the tool returns
whichever link is missing. The first call commonly returns one of:

- `"You need to sign in once before I can help. Click here: <URL>"` — surface verbatim.
- `"You haven't connected calendly. Click here: <URL>"` — surface verbatim.
- `"You have a pending approval for alter_calendly_…: <URL>"` — wait.

In all three cases, do NOT retry. Wait for the user's next message.

## Typical flows

- "What meetings do I have on Calendly this week?"
  1. `alter_calendly_get_current_user` → grab `resource.uri`.
  2. `alter_calendly_list_scheduled_events(userUri, minStartTime=<start>, maxStartTime=<end>, status="active")`.

- "Who's booked into my product demo this week?"
  1. List scheduled events as above.
  2. For each interesting event, call `alter_calendly_list_event_invitees(eventUuid)` (the UUID is the tail of `resource.uri`).

- "Send me a one-time link for my 30-min intro call."
  1. `alter_calendly_get_current_user` → `uri`.
  2. `alter_calendly_list_event_types(userUri, active=true)` → find the matching event type by `name`; grab its `uri`.
  3. `alter_calendly_create_scheduling_link(eventTypeUri)`. Surface the returned `booking_url`.

- "Cancel my 3pm Tuesday."
  1. List scheduled events to confirm which booking; extract `eventUuid` from `resource.uri`.
  2. `alter_calendly_cancel_event(eventUuid, reason?)`.

## When NOT to use

- The user wants to *reschedule* an event in place — Calendly's API has no reschedule endpoint; cancel + new scheduling link instead.
- The user wants to *create or modify* an event type — not exposed via the plugin.
- The user is asking about a Google/Outlook calendar entry, not a Calendly booking — use `alter-gcal` instead.

## Time handling

- `minStartTime` / `maxStartTime` are ISO-8601 datetimes WITH offset (e.g. `2026-05-15T15:00:00-05:00`). Infer the user's timezone from prior context — don't guess UTC.
