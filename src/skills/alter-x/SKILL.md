---
name: alter-x
description: Read and post on X (Twitter) as the asking user via the Alter plugin.
---

# alter-x

Use this skill when the user asks to **post a tweet**, **reply to a tweet**, or **fetch recent tweets** by a specific X (Twitter) user.

## Tools available

- `alter_x_get_current_user()` — `GET /2/users/me`. Returns the signed-in user's numeric `id`, `username`, and `name`. Call this first when you need an X user id (e.g. to feed into `alter_x_list_user_tweets`).
- `alter_x_post_tweet(text, replyToTweetId?)` — `POST /2/tweets`. **HITL-approved**. Pass `replyToTweetId` (numeric) to reply to an existing tweet. Requires the `tweet.write` scope.
- `alter_x_list_user_tweets(userId, maxResults?)` — `GET /2/users/:id/tweets`. Recent tweets authored by `userId` (numeric, NOT @handle). Reverse-chronological, excludes retweets/replies. Not HITL.

## Auth gates

Two gates apply (full picture in the `alter-accounts` skill): the user signs in once
(identity), then connects X once (provider). You can offer either link proactively
(`/alter connect x`) or just attempt the action — the tool returns whichever link is
missing. First call may return:

- `"You need to sign in once before I can help. Click here: <URL>"` — surface verbatim.
- `"You haven't connected X (Twitter). Click here: <URL>"` — surface verbatim. (User can also type `/alter connect x` or `/alter connect twitter`.)
- `"Awaiting your approval at <URL>"` — user resolves in wallet before retry.

Do NOT retry the tool on these — wait for the user.

## When to use

- "tweet 'shipping today!'" → `alter_x_post_tweet` with `text: "shipping today!"`
- "reply to https://x.com/.../status/1234567890 with 'congrats'" → extract the numeric tweet id from the URL, call `alter_x_post_tweet` with `replyToTweetId: "1234567890"`
- "show me my last 10 tweets" → `alter_x_get_current_user` to get `id`, then `alter_x_list_user_tweets` with that id

## When NOT to use

- The user asks to search the X firehose, fetch the home timeline, like/retweet/bookmark a tweet, follow/unfollow a user, upload media, or send a DM — none installed.
- The user asks to delete a tweet — not installed; recommend doing it in the X app.
- The user gives an @handle and expects you to resolve it to an id — `alter_x_list_user_tweets` needs the numeric id, and we don't have a username→id resolver tool installed.
- Standard X API tier: `text` is limited to 280 characters. Premium accounts can go longer. If a tweet would exceed the user's plan, X 400s and you'll see a BackendError — confirm length with the user first if they're sending something long.
