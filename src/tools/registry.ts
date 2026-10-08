import type { TSchema } from "typebox";
import type { AlterToolSpec } from "./base.js";
import { gmailSearchSpec } from "./gmail-search.js";
import { gmailGetMessageSpec } from "./gmail-get-message.js";
import { gmailSendSpec } from "./gmail-send.js";
import { gcalListEventsSpec } from "./gcal-list-events.js";
import { gcalCreateEventSpec } from "./gcal-create-event.js";
import { driveSearchSpec } from "./drive-search.js";
import { driveGetFileSpec } from "./drive-get-file.js";
import { notionSearchSpec } from "./notion-search.js";
import { notionCreatePageSpec } from "./notion-create-page.js";
import { slackSearchSpec } from "./slack-search.js";
import { slackPostMessageSpec } from "./slack-post-message.js";
import { githubSearchIssuesSpec } from "./github-search-issues.js";
import { githubCreateIssueSpec } from "./github-create-issue.js";
import { githubCreateCommentSpec } from "./github-create-comment.js";
import { linearSearchIssuesSpec } from "./linear-search-issues.js";
import { linearCreateIssueSpec } from "./linear-create-issue.js";
import { calendlyGetCurrentUserSpec } from "./calendly-get-current-user.js";
import { calendlyListEventTypesSpec } from "./calendly-list-event-types.js";
import { calendlyListScheduledEventsSpec } from "./calendly-list-scheduled-events.js";
import { calendlyListEventInviteesSpec } from "./calendly-list-event-invitees.js";
import { calendlyCreateSchedulingLinkSpec } from "./calendly-create-scheduling-link.js";
import { calendlyCancelEventSpec } from "./calendly-cancel-event.js";
import { linkedinGetCurrentUserSpec } from "./linkedin-get-current-user.js";
import { linkedinListPostsSpec } from "./linkedin-list-posts.js";
import { linkedinSharePostSpec } from "./linkedin-share-post.js";
import { xGetCurrentUserSpec } from "./x-get-current-user.js";
import { xPostTweetSpec } from "./x-post-tweet.js";
import { xListUserTweetsSpec } from "./x-list-user-tweets.js";
import { webSearchSpec } from "./web-search.js";
import { PROVIDER_IDS } from "./providers.js";

export const TOOL_SPECS: ReadonlyArray<AlterToolSpec<TSchema>> = [
  gmailSearchSpec,
  gmailGetMessageSpec,
  gmailSendSpec,
  gcalListEventsSpec,
  gcalCreateEventSpec,
  driveSearchSpec,
  driveGetFileSpec,
  notionSearchSpec,
  notionCreatePageSpec,
  slackSearchSpec,
  slackPostMessageSpec,
  githubSearchIssuesSpec,
  githubCreateIssueSpec,
  githubCreateCommentSpec,
  linearSearchIssuesSpec,
  linearCreateIssueSpec,
  calendlyGetCurrentUserSpec,
  calendlyListEventTypesSpec,
  calendlyListScheduledEventsSpec,
  calendlyListEventInviteesSpec,
  calendlyCreateSchedulingLinkSpec,
  calendlyCancelEventSpec,
  linkedinGetCurrentUserSpec,
  linkedinListPostsSpec,
  linkedinSharePostSpec,
  xGetCurrentUserSpec,
  xPostTweetSpec,
  xListUserTweetsSpec,
  webSearchSpec,
];

export const TOOL_NAMES: ReadonlyArray<string> = TOOL_SPECS.map((s) => s.name);

// Defense-in-depth: TS already enforces AlterToolSpec.provider ∈ ProviderId at compile time,
// but if a JS consumer or runtime mutation slips through, fail fast at load.
{
  const known = new Set<string>(PROVIDER_IDS);
  for (const spec of TOOL_SPECS) {
    if (!known.has(spec.provider)) {
      throw new Error(
        `[alter] tool "${spec.name}" has provider "${spec.provider}" which is not in providers.ts. ` +
          `Add it to PROVIDERS or fix the spec.`,
      );
    }
  }
  // Reject duplicate tool names — copy-paste of a spec without renaming
  // would silently shadow the original when registered with OpenClaw's
  // tool API.
  const seen = new Set<string>();
  for (const spec of TOOL_SPECS) {
    if (seen.has(spec.name)) {
      throw new Error(
        `[alter] duplicate tool name "${spec.name}" in TOOL_SPECS — every spec must have a unique name.`,
      );
    }
    seen.add(spec.name);
  }
}
