# SPACE pulse notifications: Slack DMs with email fallback

Status: approved by the maintainer on 2026-10-13; implementation plan approved; local implementation and controlled transport proof complete. Real provider setup and delivery remain operator-dependent.
Date: 2026-10-13
Owner: Liam Gulliver

## Intent and accepted choices

Help team members discover open surveys, remember to respond, and find closed results without polling Clio. Preserve confidential team aggregates, frozen pulse rosters and current workspace authorization.

The maintainer selected email and Slack notifications, private Slack DMs, and Slack first with email fallback. Approval of this spec includes SMTP, explicit Slack account linking, timings and the other defaults below. This is a new application subsystem, not an OEMS metric or a change to survey calculations.

## Approach

Use a PostgreSQL outbox and a separate server worker, consistent with existing durable collection workers. Pulse transitions and notification events commit in the same authorized transaction. Provider calls occur outside database transactions.

Alternatives considered: synchronous sends inside HTTP requests make pulse actions depend on provider availability and make safe retries harder; an external automation service introduces another credential/data boundary and operating dependency. The outbox keeps pulse actions reliable and supports controlled local proof without selecting a paid service.

Keep application behavior under `apps/api/src/features/notifications` and browser controls under `apps/web/src/features/notifications`. Provider transport helpers remain server-only; do not prematurely create a shared package. Existing pulse and identity repositories remain authoritative. Assign the next migration explicitly during planning; do not modify applied migrations.

## Events and recipient eligibility

- **Pulse opened:** one invitation event per member of the frozen roster.
- **Reminder:** default first reminder 48 hours after opening, with one further reminder 72 hours later. Owners may choose a first delay and repeat interval of 24–168 hours, and a maximum of 1–3 reminders, or disable reminders. Database time controls scheduling. No automatic pulse creation or closure.
- **Pulse closed:** one closure event per frozen-roster member, linking to the saved pulse. Say “Pulse closed” rather than claiming reportable results when all questions are suppressed.
- **Owner reminder:** an explicit confirmed action queues one reminder batch, at most once per pulse per 24 hours. It shares the per-member reminder cap and does not list recipients.

Workspace notification switches start disabled. Enabling notifications applies to pulses opened afterwards; it does not silently backfill existing surveys. Opening freezes notification timing and enabled event kinds alongside existing pulse context. Workspace disable still cancels pending work immediately; re-enabling does not replay cancelled events. Turning reminders off for an open pulse cancels its remaining reminders and does not alter the survey.

Invitations and reminders require an open pulse, frozen-roster eligibility, current workspace membership and no accepted response. Closure notices require a closed pulse, frozen-roster eligibility and current membership. Recheck eligibility before each provider call and each fallback. Cancellation, response acceptance, membership revocation and disabling notifications invalidate pending jobs; later team moves do not remove a frozen-roster member. A network call already in flight can still complete after a state change; document this limit rather than promising recall.

The scheduler catches up only the latest eligible reminder for each member, never sends multiple missed reminders in a burst, and records skipped earlier slots. Invitation/reminder events expire when the pulse stops being open; each queued reminder additionally expires 48 hours after its scheduled time. Closure events expire after seven days.

## Slack setup and member identity

An operator registers and installs a Slack App deliberately. Private operator grants bind each Clio workspace to one exact Slack workspace/team and bot credential. Secrets stay in environment/private files outside Git, following existing operator-credential policy; no browser token entry or token readback. An owner may enable only an operator-authorized integration. Verify bot workspace identity before enabling delivery, and fence queued attempts against current configuration revisions and credential rotation.

Members already signed into Clio choose **Link Slack account** within a current workspace. A separate Slack OpenID Connect flow proves that member's Slack user and workspace identity. It does not create a Clio session, replace GitHub login, implicitly link accounts by email, or assign team/workspace membership. Require current Clio session/membership at initiation and callback; bind a short-lived, single-use state and nonce to that session, Clio user, workspace and configured Slack workspace. Validate issuer, audience, signature, expiry, nonce and workspace identity; reject replay, wrong workspace, revoked sessions and concurrent identity collisions. Reauthenticate through Slack for relinking.

Store only verified Slack workspace/user identifiers and binding metadata, scoped to the current Clio member. One Slack identity may bind to at most one Clio member within a workspace. Owners cannot enter another person's Slack ID or inspect private bindings. Members can unlink; subsequent unsent events use email if eligible. Keep user access tokens transient and discard them after identity verification. No Slack email-directory search, display-name matching or channel-history access.

The bot uses `conversations.open` with one verified user ID, then `chat.postMessage` to the resulting one-to-one DM. Request bot permissions `im:write` and `chat:write`; do not request public-channel posting, message-history or impersonation scopes. The identity flow uses separate OpenID scopes and consent, not bot scopes mixed into the same authorization request. No survey answers are collected through Slack.

Primary references: [Slack OpenID Connect](https://docs.slack.dev/authentication/sign-in-with-slack/), [opening a DM](https://docs.slack.dev/reference/methods/conversations.open/), [posting messages](https://docs.slack.dev/reference/methods/chat.postmessage).

## Email setup and fallback

Use operator-configured SMTP with TLS and certificate validation, a fixed sender identity and fixed public Clio origin. No particular commercial email provider is selected. Live messages need a browser-reachable public Clio origin; localhost links are allowed only in the explicit development capture mode. Permit an explicit development-only local capture configuration; production mode refuses insecure transport. No arbitrary SMTP host, sender, message body or redirect URL comes from browser input.

Fallback uses the member's current verified identity email, re-read server-side at delivery. An unverified or missing email is unavailable, not a guessed address. Workspace owners cannot override recipients. Never copy full recipient addresses into browser-visible delivery status or logs.

Choose Slack when the member has a current verified binding and an authorized enabled integration. Use email when Slack is unlinked/unavailable, explicitly rejects the recipient/message, or exhausts retries for failures known not to have accepted a message. Check email eligibility again before sending.

A timeout, dropped connection, malformed response after sending, provider internal error that may have partially succeeded, or crashed worker during submission is **uncertain**. Do not immediately send email or blindly retry that message: it may already have reached Slack. Preserve the event as uncertain. An owner may explicitly confirm a bounded retry, with a warning that another message may arrive; the same rule applies to uncertain SMTP acceptance. Provider acceptance is not proof of inbox delivery or reading. No exactly-once external-delivery claim.

## Durable delivery and limits

Persist immutable event identity `(workspace, pulse, member, event kind, reminder slot)` with a uniqueness constraint. Store routing/configuration revision and private attempt records, not survey answers. Logical states are pending, leased, retry scheduled, provider accepted, skipped, failed and uncertain; skipped reasons include response received, access removed, pulse inactive, integration disabled, expired and no eligible destination.

Use database-clock leases, bounded claims and conditional writes. Persist an attempt-start marker before issuing its network call; an expired lease after a started submission becomes uncertain, not a free resend. Crashes before any submission can safely requeue. Concurrent workers cannot lease the same event. Recheck current scope and credentials before writes and fallback; do not retarget an in-flight attempt to a newly linked account.

Each provider attempt has a ten-second network timeout. Slack and identity JSON responses are limited to 64 KiB, JWKS to 256 KiB, ID tokens to 16 KiB, and SMTP replies to 64 KiB per transaction. The worker claims one logical event at a time with a 120-second lease; each request must also fit the remaining lease deadline. Allow at most three known-safe attempts per transport, with exponential backoff capped at 15 minutes; configured provider cooldowns can delay longer until event expiry. Slack `429` respects `Retry-After` and shared workspace/method cooldowns. Conservatively pace Slack sends at one per second per Slack workspace, preserving per-conversation limits; DM-opening requests also respect their method cooldown. SMTP rate limits are operator-configurable from 1 to 60 messages per minute, default 30, and shared across worker instances. No network calls while holding database locks. See [Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits/).

Private delivery records are retained for 30 days after terminal state, then purged by bounded worker maintenance; event deduplication markers remain for the pulse lifetime so old requests cannot recreate deleted deliveries. No unbounded provider payload storage. Errors map to safe internal reason codes; redact tokens, email addresses, response bodies and message text from routine logs.

## Message content and browser experience

Templates contain a neutral invitation/reminder/closure message and a fixed-origin link to the exact pulse. Do not include answers, averages, participation counts, responder names, bearer tokens or sign-in bypass links. The message acknowledges a team pulse without reproducing workspace/team names; the authenticated Clio page supplies context. Disable Slack link/media unfurling. HTML email escapes every interpolated value and also provides plain text.

Add an owner notification setup flow for integration availability, switches, reminder defaults, preview and explicit enable. Credentials are configured by the operator, not displayed as product features. Tests send only to the initiating owner's own verified destination after explicit confirmation, never to an entered address or an entire roster.

Members see their own link state, unlink control and their own notification history. Owners see aggregate delivery-state totals and integration health, never a named recipient list, named failures, private Slack IDs or per-person reminder retries. A workspace-level retry action operates on eligible failed/uncertain events as a batch; it never enables identifying non-responders through per-member controls. Queue/attempt status cannot reveal response participation publicly. Pulse reporting suppression and owner participation permissions remain unchanged.

## Local proof, security and delivery

Use a local SMTP capture service and controlled Slack/OIDC HTTP fixtures; no real messages or new external permissions are needed for implementation proof. Document real App registration, bot/identity consent, sender configuration and deployment separately. Real installation and test-message transmission remain deliberate maintainer actions.

Acceptance tests cover atomic pulse/outbox commit and rollback, frozen rosters, submitted/unsubmitted eligibility, overlapping/manual reminder deduplication, missed-slot catch-up, current membership/session/config fences, disable/unlink/rotation races, cross-workspace reads, no named-recipient owner projection, and unchanged survey results/suppression.

Transport tests exercise Slack acceptance, definitive refusal, rate limits, ambiguous partial success, deadline and crash recovery; SMTP accepted/refused/uncertain outcomes; fallback only after known non-acceptance; no fallback after Slack acceptance; invalid/unverified email; shared pacing across workers; bounded retries/expiry and maintenance.

Identity tests exercise valid signed OpenID responses, nonce/state replay, wrong issuer/audience/workspace, invalid/expired signatures, session revocation at callback and duplicate Slack-user binding. Browser tests cover setup confirmation, role/workspace/session changes, owner/member separation, uncertain retry warnings, keyboard access and honest missing configuration. Controlled end-to-end evidence must run pulse transition → worker → local transport → safe delivery status with real random-schema PostgreSQL.

Follow committed bounded specialist workflow: isolated concurrent writers, shared-file ownership and opposite-engine review. Run `pnpm check`, meaningful real PostgreSQL integration and `git diff --check` before commits; build/regenerate routes when routes change. No live Slack/email sends, paid services or hosting changes are authorized by this design.

## Scope exclusions

No Slack channel posts, Slack survey forms, answer collection by email, email bounce/read tracking, pulse scheduling, automatic pulse closure, custom message editor, arbitrary recipient entry, hosted secret store or general-purpose alert framework. Provider collection/DORA/SPACE calculation semantics remain unchanged.
