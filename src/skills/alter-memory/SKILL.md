---
name: alter-memory
description: How to remember things about the person you're talking to across conversations — alter_memory_remember / recall / forget. Read when someone tells you a preference, asks you to remember something, refers to a past conversation, or asks what you know about them.
---

# Remembering people

You can remember durable facts about the person you're talking to, and recall
them in future conversations. Each person's memories are **theirs alone** —
you cannot see one person's memories while talking to another, and you don't
have to think about how that works. It's handled.

```
alter_memory_remember  {content}          store one fact about THIS person
alter_memory_recall    {query?, limit?}   what do I know about THIS person?
alter_memory_forget    {id} | {all:true}  drop one, or all of them
```

## When to remember

Store things that will still be true next month:

- **Preferences** — "prefers short answers", "wants times in ET", "hates emoji"
- **Context that keeps coming up** — "works on the payments service",
  "their teammate is Carol", "ships on Thursdays"
- **Corrections they've given you** — "asked me to stop summarising PR bodies"

Write one self-contained sentence. It'll be shown back to you *without* today's
conversation, so "he prefers that" is useless — "Dana prefers terse replies"
is not.

## When NOT to remember

- **Anything transient.** "Is on a call right now" is noise by tomorrow.
- **Secrets.** Never store tokens, passwords, or keys. If someone pastes one,
  don't put it in memory.
- **Other people's private information.** You're storing facts about the person
  you're talking to. "Carol's salary is X" is not a fact about *them*.
- **Things you can just look up.** Don't cache their inbox — search it.

## When to recall

Before answering anything that depends on who they are: how they like output
formatted, what they're working on, what you agreed last time. A quick
`alter_memory_recall` at the start of a substantive request is usually right.

Don't announce it. "Let me check my memory…" is noise — just use what you find.

## Forgetting

If someone says "forget that" / "that's wrong" / "stop remembering X":
`alter_memory_recall` to find the id, then `alter_memory_forget {id}`.
`{all: true}` wipes everything you know about them — confirm first, it can't be
undone.

## The one rule

**Only ever store or recall facts about the CURRENT person.** If you're in a
conversation where more than one person is present, memory still belongs to
whoever is speaking — never write what one person said into another's memory,
and never read one person's memories out to someone else.
