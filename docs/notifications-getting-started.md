# Pulse notifications: setup and verification

Status: implemented locally, with controlled Slack identity/API fixtures and loopback SMTP verification. Real Slack installation, member consent and live delivery require deliberate operator setup and verification.

Clio's notification workflow uses private Slack messages first, with verified-email fallback when Slack has not accepted a message. Survey answers and scores stay in Clio. Opening a configured pulse can invite its frozen roster; reminders target eligible members without accepted responses, and closure notices link to the authenticated pulse.

## Operator and owner responsibilities

The operator configures private provider credentials and the public Clio origin. A workspace owner enables the authorized integration, chooses invitation/reminder/closure settings, previews messages and can confirm a test to their own selected Slack or email destination. A health test never silently switches to the other channel and is limited to one per owner, workspace and channel per 24 hours; ordinary pulse messages retain Slack-first email fallback. Members link their own Slack account; owners do not enter other people's Slack IDs or email addresses.

Notification configuration is optional and starts disabled. GitHub login remains Clio's identity provider. Slack linking proves only a notification destination and grants no Clio membership. Existing pulses are not backfilled when notifications are enabled, and disabling cancels pending work rather than pausing it for a later replay.

## Owner wizard and member linking

After the operator configures the workspace grant and starts the worker, open **Developer experience**, select the workspace and find **Pulse notifications**. Owners select **Set up notifications** (or **Change notification settings** when already enabled):

1. **Integration:** check which authorized delivery channels are available. With neither configured, Next stays disabled; the wizard cannot create provider credentials or install an App.
2. **Messages and timing:** choose opening invitations, closure notices and bounded reminder timing. These choices apply to future pulse openings.
3. **Preview and test:** review the neutral messages. Optionally select your own Slack or email destination and explicitly confirm **Send a test to me**. A test uses only that channel and does not enable notifications. If the outcome is unknown, check the same request again instead of starting another send.
4. **Enable:** review settings and explicitly confirm enabling. Existing pulses are not backfilled.

Each member uses **Your Slack account** in the same panel to start linking, then completes Slack consent themselves. Linking adds no Clio membership. **Your notification history** shows only that member's own messages. Owners find aggregate delivery status and confirmed reminder/retry controls in pulse details; those controls never reveal recipient lists.

## Slack App preparation

Register and install a dedicated Slack App in the exact Slack workspace you want Clio to use. Bot delivery needs `im:write` and `chat:write`, not public-channel posting, history access, impersonation or email-directory lookup. Each message is a one-to-one DM opened for a verified linked Slack user.

Configure a separate Sign in with Slack OpenID Connect flow for member linking, with `openid profile` consent. Bot installation permissions and member identity consent are separate flows. The server callback is `/api/notifications/slack/callback` on the trusted configured API origin. Slack identity never replaces the current GitHub session.

Members begin linking inside their current Clio workspace. The server binds a single-use short-lived state/nonce to their Clio session and authorized Slack workspace, validates signed identity proof and rejects other workspaces, replay and revoked sessions. User access tokens are discarded after verification. Unlinking affects future unsent messages; it does not recall messages already accepted.

References: [Slack identity flow](https://docs.slack.dev/authentication/sign-in-with-slack/), [opening a DM](https://docs.slack.dev/reference/methods/conversations.open/), [posting messages](https://docs.slack.dev/reference/methods/chat.postmessage).

## Email preparation

Choose an SMTP service that supports implicit TLS with certificate validation. Configure a fixed sender identity and server-side credentials; no email vendor or paid service is selected by Clio. Notification links require a browser-reachable HTTPS public Clio origin. Configure your sender/domain policy with your email provider before expecting recipient inbox delivery.

Fallback uses the current verified email from the member's Clio identity. Missing/unverified addresses are unavailable; no guessed recipients or owner-entered overrides. SMTP acceptance is not proof of inbox delivery, spam-folder placement or reading.

## Private configuration

The approved operator variable is `NOTIFICATIONS_PRIVATE_CONFIG_FILE`: an absolute path to an owner-only JSON file outside any Git checkout, with no symlink path. Use permissions such as 0600. Do not put bot tokens, OpenID client secrets or SMTP passwords in browser configuration, chat or committed examples. All `VITE_` values are public.

The private configuration additionally needs a random 32-byte base64url fingerprintKey and mandatory credentialRevision values for each provider profile. This key protects stored credential fingerprints from offline password guessing and stays outside the database. Never reuse fixture keys in live mode.

The private configuration binds a fixed public origin and exact Clio workspace UUIDs to authorized SMTP and/or Slack profiles. A Slack profile identifies one exact Slack team/workspace; the server verifies bot identity before enabling delivery. Credentials never appear in browser responses or normal runtime logs.

Replace configuration files atomically for rotation. Current configuration/revisions are rechecked before provider attempts and after identity verification. Invalid or missing replacement configuration fails closed. Credential-only rotation keeps open pulses eligible, but attempt and identity-proof versions are rechecked; source/account/origin changes invalidate old scope. A credential change does not reset rate budgets or resurrect cancelled events.

Live mode requires HTTPS `APP_ORIGIN` and `AUTH_BASE_URL`, HTTPS links and implicit SMTP TLS. Use an HTTPS deployment or deliberately configured tunnel, updating the GitHub callback to match the API origin; the standard plain-localhost setup supports local capture only. Explicit local capture mode permits only loopback SMTP/HTTP and cannot mix with live Slack grants. Run the separate worker after applying the current migrations.

Live JSON template below contains placeholders, not usable credentials. Replace every placeholder privately. The configured public origin must equal Clio's trusted `APP_ORIGIN` and serve its SPA. Register `/api/notifications/slack/callback` on the trusted API `AUTH_BASE_URL` as the exact HTTPS Slack callback. API and SPA origins may differ; the callback must reach the API host carrying the existing session cookie. Existing GitHub callback remains separate.

```json
{
  "mode": "live",
  "publicOrigin": "https://clio.example.com",
  "fingerprintKey": "REPLACE_WITH_RANDOM_32_BYTE_BASE64URL_KEY",
  "grants": [{
    "workspaceId": "REPLACE_WITH_CLIO_WORKSPACE_UUID",
    "smtp": {
      "host": "smtp.example.com",
      "port": 465,
      "tls": true,
      "user": "REPLACE_WITH_SMTP_USER",
      "password": "REPLACE_WITH_SMTP_PASSWORD",
      "from": "clio@example.com",
      "ratePerMinute": 30,
      "credentialRevision": "2026-10-13-1"
    },
    "slack": {
      "teamId": "REPLACE_WITH_SLACK_TEAM_ID",
      "botToken": "REPLACE_WITH_BOT_TOKEN",
      "clientId": "REPLACE_WITH_OPENID_CLIENT_ID",
      "clientSecret": "REPLACE_WITH_OPENID_CLIENT_SECRET",
      "credentialRevision": "2026-10-13-1"
    }
  }]
}
```

Omit a provider profile or set it to `null` when unavailable; each grant needs at least one. SMTP user/password must both be present or both `null`. Rate is 1–60 messages/minute, default 30. `fingerprintKey` must encode exactly 32 random bytes as 43 unpadded base64url characters. Generate and save it directly in the private file; do not print it into session logs. Each configured provider requires a nonempty `credentialRevision`; update it on rotation.

For local email capture, use `mode: "local_capture"`, a loopback HTTP `publicOrigin`, a loopback SMTP host, `tls: false`, no Slack profile and no live credentials. Capture mode is explicit; it cannot be used to bypass live TLS. No external capture service is installed by Clio.

## Pulse behavior

The approved defaults are an invitation on opening, a reminder after 48 hours and one further reminder 72 hours later, plus a neutral closure notice. Owners can change first delay/repeat interval to 24–168 hours and cap reminders at 1–3, or disable them. Opening freezes those settings. Manual owner reminders share the same per-member cap and are limited to one batch per pulse per 24 hours. A confirmed manual batch uses that allowance even when coalescing or eligibility leaves nothing to queue. A manual batch skips members with an unexpired pending, leased or retry-scheduled reminder, an older unexpired failed or uncertain invitation/reminder, or a reminder accepted by a provider within the previous 24 hours. The acceptance window starts when the worker records provider acceptance, not when the event was created. Skipped members spend no additional reminder slot; repeating the exact batch request returns its original result.

A late worker catches up only the latest eligible reminder, not a burst of missed messages. Reminder events expire 48 hours after their scheduled time and stop when the pulse closes/cancels. Closure notices expire after seven days. Submitting a response or losing workspace access suppresses pending invitations/reminders; team moves preserve frozen-roster eligibility.

Messages contain neutral text and an exact pulse link, with no answers, averages, participation counts, names, workspace/team labels or bearer tokens. Slack link/media unfurling is disabled. A signed-out member signs in with GitHub and reopens the original notification link. Linked pulse details do not depend on appearing on the current history page or having a current team.

## Delivery outcomes

- Provider accepted: Slack or SMTP acknowledged submission. This does not mean the recipient read it.
- Retry scheduled: a known non-acceptance can retry within limits and provider cooldown.
- Failed: the latest attempt was not accepted. If an earlier unknown outcome was explicitly retried, that earlier submission may still have arrived.
- Skipped: the notice expired, was disabled, no longer applied, or lacked an eligible destination.
- Uncertain: a timeout, interrupted submission or worker crash may have happened after acceptance. Clio does not blindly retry or immediately send email. An owner may explicitly confirm a bounded batch retry after acknowledging duplicate-message risk. Each channel permits at most three actual transport attempts per event, with at most one confirmed uncertain replay.

Email fallback happens only when Slack is unavailable/unlinked, definitely refused the message, or exhausted safe retries for known non-acceptance. Slack acceptance stops fallback. Ambiguous Slack errors do not turn into email spam. [Slack rate-limit responses](https://docs.slack.dev/apis/web-api/rate-limits/) delay retries; pacing is shared across worker instances.

Older failed or uncertain invitations/reminders pause further reminders for that member while the older notice remains unresolved and unexpired. The scheduler records blocked slots as missed; resolving the older notice does not restore those slots. Invitations have no time expiry while the pulse remains open and the member retains access. Reminder blockers expire at their original deadline.

Owners can review the aggregate delivery status and confirm **Retry failed deliveries** for currently eligible events. Unknown outcomes require the separate duplicate-message acknowledgement. Each channel has at most three transport attempts; exhausted limits cannot be reset or requeued by this control. Once email fallback is selected, unused Slack capacity does not make the event retryable. A confirmed unknown-outcome replay stays on its original channel. Fixing provider configuration or linking Slack does not reset attempt limits, recall accepted messages or restore missed slots.

To stop pending reminders, owners can choose **Turn off reminders for this pulse**. To cancel pending notifications across the workspace, choose **Disable notifications**. Pulse closure/cancellation and access removal also end invitation/reminder eligibility. These controls do not recall accepted or in-flight messages; re-enabling does not replay cancelled work. Clio provides no recipient directory or per-member retry control.

Owners see aggregate delivery states and integration health, not named responder/failure lists or private Slack bindings. Members see their own link state and own notification history. Survey result suppression remains unchanged. Small-team reporting remains confidential rather than guaranteed anonymous.

## Verification and limits

Implementation proof uses disposable PostgreSQL schemas, a loopback SMTP capture server and controlled signed Slack identity/API fixtures. It must exercise pulse transaction → durable worker → bounded transport → safe API status. No test installs a real App or sends messages to real participants.

Real App installation/identity consent and a live test to the initiating owner's own destination are deliberate user actions after local proof. Controlled acceptance, live provider acceptance, inbox delivery and reading are different claims and must be recorded separately. The feature does not schedule surveys, close them automatically, collect answers in Slack/email, track opens/bounces or provide a general alert platform.

Private attempts expire after 30 days in terminal state; compact pulse-lifetime deduplication markers prevent old request replay from recreating messages. The worker performs bounded scheduling/maintenance and at most one event per claim. Apply migrations explicitly before starting the API or worker. Controlled tests verify migration/readiness and the delivery path; live provider status requires a separately authorized test.

## Run and stop the worker

Apply migrations explicitly from the repository root, then start the worker separately from the API:

```sh
pnpm db:migrate
pnpm worker:notifications
```

For one bounded scheduling/maintenance cycle and at most one event:

```sh
pnpm worker:notifications --once
```

The API never applies migrations or starts a delivery worker automatically. Use SIGINT/SIGTERM to stop it. An attempt already committed for dispatch can begin or finish its bounded provider call during shutdown; interrupted submissions can become uncertain. Stopping a worker does not recall provider-accepted messages. Continuous supervision is an operator responsibility. Missing configuration performs bounded maintenance without contacting providers; malformed configuration, mismatched APP_ORIGIN, or missing/changed migrations fail with redacted errors. No SMTP server or Slack App is installed by these commands.
