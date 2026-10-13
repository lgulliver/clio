# SPACE Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Preserve Clio's committed bounded Codex/Claude specialist workflow, isolated concurrent CLI writers and opposite-engine review.

**Goal:** Deliver private pulse invitations, reminders and closure notices through Slack DMs first, with verified-email fallback only when Slack did not accept the message.

**Architecture:** Authorized pulse transactions create immutable logical notification events in a PostgreSQL outbox. A separate worker schedules, leases, rechecks eligibility and calls bounded server-only transports without holding database locks. Slack identity linking remains independent from Better Auth/GitHub login; browser views expose own status or aggregate owner status without named recipients.

**Tech Stack:** Existing TypeScript/Node 24, PostgreSQL/Fastify, React/TanStack/Vite, Vitest/Testing Library. Pin API dependencies `nodemailer@10.1.0` (bundled types; no separate `@types/nodemailer`) and `jose@6.2.12`; native fetch, crypto, net and TLS provide bounded transport. Versions checked against npm registry during planning; coordinator owns manifests and lockfile changes.

**Spec:** `docs/superpowers/specs/2026-10-13-space-notifications-design.md`, approved by the maintainer on 2026-10-13. Planning base: `8f14897`.

## Global Constraints

- Slack DMs first; email fallback. No Slack channel posts, external answer collection, composite score, pulse scheduling or automatic pulse closure.
- First reminder 48 hours after opening; one further reminder 72 hours later. Configurable first delay and interval 24–168 hours, maximum 1–3 reminders; manual batch at most once per pulse per 24 hours and within the same cap.
- Notification switches start disabled. Enable applies only to subsequently opened pulses; disable cancels pending work and re-enable never resurrects it.
- Open freezes roster, timing and enabled event kinds. Current membership, open/closed pulse state and response receipts control eligibility. Never join respondent IDs onto `space_answers`.
- Reminder expiry 48 hours after scheduled time, additionally bounded by pulse state; closure expiry seven days. Catch up only the latest eligible reminder, never a burst of missed slots.
- Claims: one logical event, 120-second database-clock lease. Network timeout ten seconds and remaining lease deadline; at most three known-safe attempts per transport, exponential backoff capped at 15 minutes.
- Slack/identity JSON 64 KiB, JWKS 256 KiB, ID token 16 KiB, SMTP replies 64 KiB per transaction. Slack send pacing one per second per Slack workspace plus method cooldowns/`Retry-After`. SMTP rate 1–60 per minute, default 30, shared across workers.
- Uncertain submission never triggers blind retry/fallback. Provider acceptance does not prove delivery/read. In-flight messages cannot be recalled after response/revocation.
- Private attempt records retained 30 days after terminal state; bounded purge retains pulse-lifetime deduplication markers.
- Operator credentials stay outside Git, server-side and absent from responses/logs. SMTP TLS certificate validation required outside explicit local capture mode. No arbitrary browser destinations or SMTP credentials.
- One verified Slack identity per Clio member/workspace; one Clio member per Slack identity/workspace. Slack consent proves identity, grants no Clio access and replaces no GitHub session. Bot scopes `im:write`, `chat:write`; identity flow separate OpenID scopes.
- Strict types; parse unknown boundaries, no `any`, unsafe assertions or suppression comments. Exact dependency versions and pnpm lockfile; no new build system/licence/paid service/hosting decision.
- Maximum three specialists across engines. Concurrent writers get separate CLI worktrees; coordinator owns shared contracts, dependencies, root scripts, integration and migration allocation. No real tokens, private logs, live messages or external installations in tests.

## Review Focus

1. Worker crash after provider submission but before success persistence: recover as uncertain, never resend/fallback. Task 4 crash/lease cases.
2. Slack or SMTP refusal versus ambiguous partial success: only evidence of non-acceptance permits fallback/retry. Task 2 classification cases and Task 4 routing discriminator.
3. Membership/configuration/link/response changes during pacing or OAuth callback: recheck current scope and refuse late mutation/send. Tasks 3–5 race cases.
4. Manual reminders racing catch-up, including long outage: shared cap and logical deduplication prevent burst/duplicate sends. Tasks 1/4 concurrent PostgreSQL cases.
5. Notification link targets older/deleted-team pulse or signed-out user: exact authenticated detail read independent of 25-row history; no bearer-link access or membership disclosure. Tasks 5/6 HTTP/browser cases.

## Ownership and dependency map

| Task | Owner/boundary | Owned files | Depends on |
| --- | --- | --- | --- |
| 1 | Backend / contracts and durable foundation | migration 0017; notifications contract/input/config/settings/event repositories and tests | approved spec |
| 2 | Providers / bounded SMTP and Slack | notifications transport files, templates, local transport fixtures/tests | 1 contracts |
| 3 | Identity / Slack proof and own binding | notifications linking files and OAuth state tests | 1 schema/config, 2 bounded HTTP helper |
| 4 | Backend / lifecycle and worker | notification scheduler/jobs/worker; SPACE lifecycle hooks; membership invalidation hook | 1, 2, 3 private binding read |
| 5 | Backend/identity / actual HTTP wiring | notifications routes and HTTP tests; identity scoped registration | 1, 3, 4 |
| 6 | Frontend / owner/member flow and deep links | web notifications feature; SPACE/page/detail integration; route search | 5 exact envelopes |
| 7 | Coordinator / proof and delivery | docs, readiness/main/worker scripts, manifests/lockfile, approved spec/plan status, controlled full-chain proof | 1–6 |

Only Task 4 writes `apps/api/src/features/space/repository.ts` and membership-hook hunks in `identity/repository.ts`. Only Task 5 writes notification registration/dependency hunks in `identity/routes.ts`. Task 6 owns its assigned SPACE browser integration files. Coordinator holds `main.ts`, `db/migrations.ts`, root/API manifests, lockfile and CI. Task1 explicitly owns the narrow private-file helper extraction/import; retain GitHub configuration behavior and its existing tests. Task 2/3 cannot edit shared contract unilaterally. Ready tasks may run concurrently only after contracts are committed; dependency copies in disposable worktrees are not accepted integration evidence.

## Shared contracts established by Task 1

New directory: `apps/api/src/features/notifications`. Export public types from `contract.ts`, not server credentials. All IDs use existing UUID/opaque Clio user parsers. Public instants are UTC strings; private comparisons use database instants/microseconds.

```ts
export type NotificationKind = 'invitation' | 'reminder' | 'closure' | 'test';
export type NotificationState = 'pending' | 'leased' | 'retry_scheduled' |
  'provider_accepted' | 'skipped' | 'failed' | 'uncertain';
export type NotificationChannel = 'slack' | 'email';
export type NotificationPolicy = Readonly<{
  revision: number; enabled: boolean; invitations: boolean; closures: boolean;
  reminders: boolean; firstReminderHours: number; repeatHours: number; maximumReminders: number;
}>;
export type NotificationAvailability = Readonly<{
  workspaceId: string; emailConfigured: boolean; slackConfigured: boolean; linkingConfigured: boolean;
}>;
export type OwnSlackLink = Readonly<{ linked: boolean; revision: number; linkedAt: string | null }>;
export type OwnNotification = Readonly<{
  id: string; pulseId: string | null; kind: NotificationKind; state: NotificationState;
  channel: NotificationChannel | null; createdAt: string; updatedAt: string;
}>;
export type OwnNotificationPage = Readonly<{
  workspaceId: string; items: readonly OwnNotification[]; nextCursor: string | null;
}>;
export type DeliverySummary = Readonly<{
  workspaceId: string; pulseId: string;
  counts: Readonly<Record<NotificationState, number>>;
  remindersEnabled: boolean; revision: number;
}>;
export type DispatchResult =
  | Readonly<{ outcome: 'accepted' }>
  | Readonly<{ outcome: 'not_accepted'; retryable: boolean; reason: 'recipient_unavailable' | 'provider_unavailable' | 'configuration_invalid'; retryAfterMs?: number }>
  | Readonly<{ outcome: 'uncertain'; reason: 'acceptance_unknown' }>;
export type NoticeMessage = Readonly<{ subject: string; text: string; html: string; slackText: string }>;
```

`test` has no pulse and uses initiating owner as its only recipient. Summary exposes no recipient IDs, names, addresses, Slack IDs, response-based skipped reasons or per-person errors. Private storage may keep safe reason codes; own projections may only disclose that member's own context.

`config.ts` exports `NotificationConfig` (private), `readNotificationConfig(env: NodeJS.ProcessEnv): Promise<NotificationConfig | null>`, and `notificationGrant(config: NotificationConfig | null, workspaceId: string): NotificationGrant | null`. Private `NotificationGrant` contains `workspaceId`, a revision fingerprint, optional authorized SMTP destination profile and optional `{ teamId, botToken, clientId, clientSecret }` Slack profile. Use one operator-only `NOTIFICATIONS_PRIVATE_CONFIG_FILE`; absent disables, malformed/partial setup fails redacted. Explicit JSON mode `live` or `local_capture`, fixed `publicOrigin`, SMTP host/port/TLS/auth/sender/rate and exact workspace grants. In live mode origin HTTPS, implicit SMTP TLS; in capture mode loopback HTTP origin/SMTP only, no live Slack credentials. Do not silently permit STARTTLS downgrade. Extract existing `privateFile(path,maxBytes)` to `readPrivateFile(path:string,maxBytes:number):Promise<string>` in `apps/api/src/lib/private-file.ts`; both GitHub and notification configuration consume it. Existing private-file checks are reused/extracted narrowly, with regression coverage, not copied insecurely. Fingerprints cover capability, workspace/team, SMTP identity and credential revisions without publishing secret hashes.

Production `configNow` re-reads the validated private operator file at each action/claim and before provider calls or post-network binding writes; tests may supply a mutable in-memory reader. Atomic file replacement is the documented rotation path. Missing/invalid new configuration fails closed; old cached credentials cannot be used as fallback authority. Workspace policy changes increment the stored revision; configuration fingerprints include fixed origin as well as destination/capabilities. Slack policy enable receives a server-only proof from `verifySlack` outside the transaction, then rechecks current grant fingerprint/team inside authorization before committing; browser bodies cannot supply that proof.

Private configuration types in `config.ts` are fixed for later tasks:

```ts
export type SmtpProfile = Readonly<{
  host:string; port:number; user:string|null; password:string|null;
  from:string; ratePerMinute:number;
}>;
export type SlackProfile = Readonly<{
  teamId:string; botToken:string; clientId:string; clientSecret:string;
}>;
export type NotificationGrant = Readonly<{
  workspaceId:string; fingerprint:string; smtp:SmtpProfile|null; slack:SlackProfile|null;
}>;
export type NotificationConfig = Readonly<{
  mode:'live'|'local_capture'; publicOrigin:string; grants:readonly NotificationGrant[];
}>;
```

SMTP user/password must be both present or both null. A grant needs at least one destination profile; duplicate workspace IDs are invalid. The fixed sender and SMTP endpoint/auth-user form the private pacing key, so password rotation cannot replenish rate budget. Fingerprints include credential revisions, not secret values exposed to users. Live grants use implicit TLS; loopback plaintext capture is explicit and cannot mix with Slack grants.

New low-level functions accept existing transaction client, never start a nested transaction:

```ts
capturePulseNotifications(client: PoolClient, workspaceId: string, pulseId: string): Promise<void>;
closePulseNotifications(client: PoolClient, workspaceId: string, pulseId: string): Promise<void>;
cancelPulseNotifications(client: PoolClient, workspaceId: string, pulseId: string): Promise<void>;
suppressMemberNotifications(client: PoolClient, workspaceId: string, userId: string, pulseId?: string): Promise<void>;
```

`createNotificationRepository(pool: Pool, config: NotificationConfig | null, dependencies?: {configNow?:()=>Promise<NotificationConfig|null>})` produces methods `availability(actor,wid)`, `policy(actor,wid)`, `updatePolicy(actor,wid,input:unknown,verification?:{teamId:string;grantFingerprint:string})`, `ownLink(actor,wid)`, `unlink(actor,wid,input:unknown)`, `ownHistory(actor,wid,query:unknown)`, `summary(actor,wid,pulseId)`, `remind(actor,wid,pulseId,input:unknown)`, `disableReminders(actor,wid,pulseId,input:unknown)`, `retryBatch(actor,wid,pulseId,input:unknown)`, `testDelivery(actor,wid,input:unknown)`. `actor: Actor`, `wid/pulseId: string`; return respective public type, or batch response `{ requestId:string; queued:boolean }` without recipient count/IDs. All user reads/writes use `authorizedWorkspaceTransaction`; worker reads are trusted-system transactions with current membership and integration fences, not synthetic user actors.

## Task 1: Durable notification foundation and safe configuration

**Files:** Create `apps/api/migrations/0017_notifications.sql`; `apps/api/src/lib/private-file.ts`; modify only the shared private-file helper import in `apps/api/src/features/github-collection/config.ts`; `apps/api/src/features/notifications/{contract,input,config,repository,events}.ts`; `apps/api/tests/{notifications-contract,notifications-config}.test.ts`; `apps/api/tests/notifications.integration.ts`. Coordinator reserves 0017 after confirming 0016 remains latest and pins manifests/lockfile for Tasks 2/3.

**Interfaces:** Produces all shared types, private config/grant reader, user repository and transaction hooks above. Consumes existing `Actor`, `authorizedWorkspaceTransaction`, strict identity input helpers and `PoolClient`.

- [ ] Add random-schema tests for default disabled policy, owner-only revisioned changes, exact frozen policy/event identities, private/public projection distinction, workspace hiding and bounded own-history pagination. Include concurrent manual-request replay with changed bodies returning409.

```ts
const before = await notifications.policy(member, workspace.id);
expect(before.enabled).toBe(false);
await expect(notifications.updatePolicy(member, workspace.id, enabledPolicy)).rejects.toMatchObject({ status: 403 });
expect(JSON.stringify(await notifications.summary(owner, workspace.id, pulse.id))).not.toMatch(/userId|email|slackUserId|recipient/);
```

- [ ] Run named contract/config and `notifications.integration.ts` tests; observe RED from missing new code/schema, not unrelated environment failures.
- [ ] Add workspace policy, frozen pulse policy/scheduler cursor, minimal logical events, private attempt records, workspace-scoped Slack bindings/OAuth states, manual batch identities and durable quota tables. Separate dedup markers from 30-day attempt retention. Composite FKs enforce workspace/pulse/member context, uniqueness enforces event and Slack identity ownership, CHECKs prevent impossible lease/terminal/attempt states. Define no cascade that erases frozen pulse history when team assignments change. Member removal invalidates bindings without destroying pulse roster.
- [ ] Implement parsers and config validation; test file ownership/mode/symlink/outside-Git limits, CRLF/email/header injection, integer/range checks, HTTPS origin and explicit loopback-only capture. No real private files are inspected.
- [ ] Implement set-based atomic pulse hooks and revision-fenced policy/reminder/test/retry request intents. Use distinct occurrence keys `auto:<scheduled-slot>` and `manual:<requestId>` plus a globally reserved per-member `reminder_slot` ordinal1–3; two unique keys prevent scheduled/manual collision and replay. Skipped historical schedule markers do not consume a sendable reminder ordinal. Reminder cap is per frozen-roster member across manual/automatic slots; policy row/workspace lock serializes batch mutation. Exact request replay returns original batch, changed body409. Uncertain retry warning requires `confirmUncertain:true`, maximum one explicit uncertain replay per event, counts within transport ceilings and safe current eligibility; accepted events never requeue.
- [ ] History pages contain25rows maximum, cursor bound to actor/workspace/history-kind; return next cursor only on full page. Summary owners only; own endpoints derive user from actor and accept no user selector. Add tests for corrupt stored payloads returning redacted safe error.
- [ ] Run focused tests, actual PostgreSQL cases, typecheck, `pnpm check` and diff check; opposite-engine review. Commit `feat(notifications): add scoped durable notification foundation`.

## Task 2: Bounded Slack and SMTP transport with honest outcomes

**Files:** Create `apps/api/src/features/notifications/{http,templates,slack,smtp,smtp-socket,provider}.ts`; `apps/api/tests/{notifications-templates,notifications-slack,notifications-smtp}.test.ts`; `apps/api/tests/fixtures/notification-transports.ts`. Coordinator adds exact API dependencies identified above.

**Interfaces:** `renderNotice(kind: NotificationKind, link: string): NoticeMessage`; `boundedNotificationJson(url: URL, init: RequestInit, signal: AbortSignal, maximumBytes: number): Promise<unknown>` (fixed Slack endpoint allowlist in consumers, no redirects). `NotificationProvider` exposes `verifySlack(grant: NotificationGrant, signal: AbortSignal): Promise<{teamId:string}>`, `openDm(grant,userId:string,signal): Promise<{channelId:string} | DispatchResult>`, `sendSlack(grant,channelId:string,message:NoticeMessage,signal): Promise<DispatchResult>`, `sendEmail(grant,email:string,message:NoticeMessage,signal): Promise<DispatchResult>`. `createNotificationProvider(config: NotificationConfig): NotificationProvider`; `buildPulseLink(origin:string,wid:string,pulseId:string): string` returns only `/developer-experience?workspace=<UUID>&pulse=<UUID>`. Slack codes/SMTP responses parsed from unknown, never returned raw.

- [ ] Write discriminator tests: Slack `ok:true`, definitive `ok:false`,429, `internal_error`/`fatal_error`, body truncation after a message submission; SMTP final250,550refusal,451retryable refusal, disconnect after DATA, slow greeting and oversized response. Tests verify no survey content, addresses or tokens in returned outcomes.

```ts
expect(classifySlack({ ok: false, error: 'internal_error' })).toEqual({ outcome: 'uncertain', reason: 'acceptance_unknown' });
expect(renderNotice('closure', link).slackText).toContain('Pulse closed');
expect(renderNotice('reminder', link).text).not.toMatch(/responded|average|score|participants/);
```

Private test fixtures define `enabledPolicy` as `{revision:1,enabled:true,invitations:true,closures:true,reminders:true,firstReminderHours:48,repeatHours:72,maximumReminders:2}` and `validCallback(start:{authorizeUrl:string})` as `{state:new URL(start.authorizeUrl).searchParams.get("state"),code:"signed-fixture-code"}`; signed token responses use the corresponding nonce from the private test state. Define `classifySlack(value:unknown): DispatchResult` in `slack.ts`; unknown/malformed post-submission responses are uncertain, not known refusal.

- [ ] Observe RED with focused tests. Implement fixed templates, safe escaping, text+HTML email and no Slack unfurls. Stable internal event identity helps deduplication but is not claimed as an external exactly-once guarantee. Only one SMTP envelope recipient; no cc/bcc or provider-managed bulk retries.
- [ ] Use `conversations.open` with exactly one linked user, then `chat.postMessage` to returned DM; validate exact `auth.test` workspace identity. Safe non-acceptance allowlist: `user_not_found`, `channel_not_found`, `account_inactive`, `invalid_auth`, `token_revoked`, `missing_scope`, `not_authed`, `no_permission`; ambiguous internal/fatal/unknown errors stay uncertain for message posting.429 is known rejection and carries bounded retry delay. Opening a DM is not message submission; failures there cannot imply a sent survey message, but still receive bounded retry/cooldown classification.
- [ ] Use Nodemailer public transport API, pool disabled, fixed single-recipient envelope, file/URL access disabled, TLS cert checks and all three connection/greeting/socket timeouts ≤10seconds. Live SMTP uses an owned implicit-TLS socket (`tls.connect`, certificate/SNI validation) supplied through supported `getSocket` with `secured:true`; local capture uses bounded loopback net socket. Attach a cumulative decoded reply-byte guard before handing socket to Nodemailer; terminate at64KiB and destroy socket on abort/remaining deadline. No monkey-patching library internals or credential-bearing protocol logger. If supported typed hook cannot enforce limits, stop this slice and present a narrowly evidenced design adjustment; do not silently relax spec or substitute handwritten SMTP.
- [ ] Treat explicit negative SMTP replies and provable pre-submission connection failure as not accepted; DATA acknowledgement/drop ambiguity as uncertain. Success requires final acceptance for the single expected recipient, not mere RCPT acceptance. Destroy transport in finally; do not print its errors.
- [ ] Run transport tests with local ephemeral ports/TLS fixture CA; never disable production certificate validation for tests. Check versioned bundled typings/imports. Coordinator/opposite-engine review and `pnpm check`/diff check before commit `feat(notifications): add bounded Slack and SMTP delivery`.

## Task 3: Session-bound Slack identity proof and private linking

**Files:** Create `apps/api/src/features/notifications/{slack-identity,link-repository}.ts`; `apps/api/tests/notifications-slack-identity.test.ts`; `apps/api/tests/notifications-link.integration.ts`. Do not modify Better Auth providers or public user shape.

**Interfaces:** `createSlackLinkRepository(pool,config,identityProvider?)` returns `begin(actor:Actor,wid:string): Promise<{authorizeUrl:string}>`, `complete(actor:Actor,callback:unknown): Promise<{workspaceId:string;linked:true}>`; `SlackIdentityProvider.verifyCode(input:{code:string;nonce:string;grant:NotificationGrant;signal:AbortSignal}): Promise<{teamId:string;userId:string}>`; private `readSlackBinding(client:PoolClient,wid:string,userId:string)` returns verified IDs/revision only to trusted delivery code. `begin` creates five-minute DB-clock single-use state, bound to session/user/workspace/grant revision; state stored hashed, nonce private. Uses Task2 bounded HTTP helper.

- [ ] Add signed OpenID fixtures via jose test keys, separate token/userInfo/JWKS HTTP fixtures, and real PostgreSQL state tests. Wrong issuer/audience/workspace, duplicate nonce/state, missing claims, bad/expired signature, userInfo subject mismatch and oversized JWT/JWKS must reject.

```ts
const start = await linking.begin(member, workspace.id);
expect(new URL(start.authorizeUrl).searchParams.get('scope')).toBe('openid profile');
await identity.revokeMember(owner, workspace.id, member.userId);
await expect(linking.complete(member, validCallback(start))).rejects.toMatchObject({ status: 404 });
```

- [ ] Observe RED. Implement strict issuer `https://slack.com`, audience equal configured clientId, RS256 only, verified nonce/expiry/subject and required Slack team/user claims. Use jose verification and an allowlisted bounded JWKS fetch, no JWT-supplied URL/discovery redirection. Token endpoint receives private client credentials; profile/token discarded after verified binding. Validate `openid.connect.userInfo` against token subject when used. Separate bot and identity consent flows; no `email` scope needed for linking.
- [ ] Reserve/consume state atomically before network, verify outside transaction, then reauthorize original session/member/grant and commit binding. Failed consumed state cannot replay; explicit new link flow can retry. Unlink is revision-fenced, clears cached DM identity and invalidates unsent routing without altering accepted messages. Changing provider workspace invalidates old bindings.
- [ ] Race two members linking same Slack identity: one wins, other409; same-user callback replay does not mutate a new binding. Current-session revocation during verification rejects late binding. Private state consumption updates only an unused, unexpired row under its original session; competing callbacks cannot both consume it. Production linking rereads current private config before begin/verification/commit, rather than trusting a constructor snapshot. Own link read exposes boolean/revision/time only; no owner directory/export.
- [ ] Run named unit/integration tests and existing identity regressions, opposite-engine identity review, coordinator `pnpm check`/diff check. Commit `feat(identity): link verified Slack accounts for notifications`.

## Task 4: Atomic pulse events, scheduler and fenced notification worker

**Files:** Create `apps/api/src/features/notifications/{scheduler,jobs,worker,maintenance}.ts`; `apps/api/src/worker-notifications.ts`; modify lifecycle hunks in `apps/api/src/features/space/repository.ts` and member-revocation hunks in `identity/repository.ts`; create `apps/api/tests/notifications-worker.test.ts` and `apps/api/tests/notifications-worker.integration.ts`. Root worker script wiring remains coordinator-owned.

**Interfaces:** `advanceNotificationSchedule(pool:Pool,limit?:number): Promise<number>` defaults25pulses, hard maximum100; bounded recipient traversal100rows per transaction with durable cursor. `processOneNotification(pool:Pool,config:NotificationConfig,dependencies?:{provider?:NotificationProvider;signal?:AbortSignal;configNow?:()=>Promise<NotificationConfig|null>}): Promise<boolean>`; `maintainNotifications(pool:Pool,limit?:number): Promise<number>` defaults100, maximum500terminal events. Worker resolves current grant, current Slack binding or verified email before every attempt, and routes from Task2 DispatchResult. Internal job functions accept lease UUID and condition all state writes on current lease/config/eligibility.

- [ ] Add actual PostgreSQL lifecycle cases using `createSpaceRepository(pool).transition(actor,wid,pulseId,action)` and `.submit(actor,wid,pulseId,body)`. Force outbox constraint failure and prove pulse opening/closing/response transaction rolls back with original state/raw-answer retention intact. Disabled default creates no sendable events. Close/cancel replay and existing-receipt submission do not duplicate events.

```ts
await space.transition(owner, workspace.id, pulse.id, 'open');
await space.submit(member, workspace.id, pulse.id, answers);
await processOneNotification(pool, config, { provider: recorder });
expect(recorder.messagesFor(member.userId)).toEqual([]);
expect(await space.get(member, workspace.id, pulse.id)).toMatchObject({ submitted: true });
```

`recorder.messagesFor` belongs only to the private test fixture, never provider/public API. Test event eligibility, not direct identity lookup through public delivery data.

- [ ] Observe RED. Call capture hook after frozen roster insertion, close hook after saved results, cancel hook inside cancellation, suppress hook on accepted/replayed response and inside membership deletion. No network or nested transaction in these hooks; bind workspace/pulse UUIDs in every SQL path. No response receipt/answer join.
- [ ] Scheduler uses DB time, frozen policy, 100-recipient cursor and event uniqueness. Compare actual instants, choose latest due slot and record skipped earlier slots; serialize automatic/manual quota reservation using the same pulse/member rows. Failed/uncertain jobs block younger reminder sends to that member until resolved/expired, preventing a second reminder from bypassing uncertainty. Reminders stop on submitted receipts/closed pulse, future slots are never pre-delivered.
- [ ] Add concurrent-claim/manual-scheduler races, delayed25/100-row continuation, two-interval missed slots,1/3caps, disabling/removing membership while paced, team move retaining roster, unlink/config rotation before attempt and DB/host clock skew. Preserve event deadline across retries/cooldowns.
- [ ] Persist attempt-start marker after pacing and eligibility check, before submission. A message attempt with expired lease becomes uncertain; opening-DM-only crash may safely resume. Simulate provider acceptance then crash before DB completion: next worker must call neither transport. Accepted Slack never falls back; missing link goes directly to verified email; refusal/known retry exhaustion permits fallback; uncertain Slack does not. SMTP uncertain stays uncertain. Rate limits reserve durable shared quotas without holding locks while waiting; attempts are not charged for cooldown-only deferral.
- [ ] Maintenance deletes terminal private attempts older than30days in bounded batches, retains compact event dedup markers and OAuth security audit minima, and expires unused link states. Tests prove purged markers prevent request replay recreation. Limit retained provider metadata to safe reason/channel/time; no raw responses/messages.
- [ ] Worker startup follows existing native-TS readiness/`--once`/SIGINT shutdown pattern. `--once` advances one bounded scheduler/maintenance batch and at most one sendable event; continuous mode avoids busy polling and terminates aborted requests conservatively. Absent config stays disabled; partial config fails redacted.
- [ ] Run focused worker/storage plus unchanged SPACE/identity integration suites; opposite-engine review; coordinator checks. Commit `feat(notifications): deliver durable pulse events with safe fallback`.

## Task 5: Actual scoped API, own delivery history and owner controls

**Files:** Create `apps/api/src/features/notifications/routes.ts`; `apps/api/tests/notifications-routes.test.ts`; `apps/api/tests/notifications-http.integration.ts`; modify only notification dependency/registration hunks in `apps/api/src/features/identity/routes.ts`. Coordinator owns startup/readiness integration.

**Interfaces:** `registerNotificationRoutes(server:FastifyInstance,dependencies?:{pool:Pool;config:NotificationConfig|null;configNow?:()=>Promise<NotificationConfig|null>;actor:(request:FastifyRequest,reply:FastifyReply,write:boolean)=>Promise<Actor>;provider?:NotificationProvider;identityProvider?:SlackIdentityProvider})`. Trusted fixture seams never come from request or live startup. Prefix `/api/workspaces/:workspaceId/notifications`:

| Method/path | Access | Exact public result |
| --- | --- | --- |
| GET `/availability` | member | availability object |
| GET/PATCH `/policy` | owner | `{policy:NotificationPolicy}` |
| GET `/slack-link` | own member | `{link:OwnSlackLink}` |
| POST `/slack-link/start` | own member | `{authorizeUrl:string}` |
| POST `/slack-link/unlink` | own member | `{link:OwnSlackLink}`; body `{revision}` |
| GET `/history` | own member | OwnNotificationPage; optional cursor only |
| GET `/pulses/:pulseId` | owner | DeliverySummary |
| POST `/pulses/:pulseId/remind` | owner | batch202; `{requestId,revision}` |
| POST `/pulses/:pulseId/reminders/disable` | owner | DeliverySummary; `{revision}` |
| POST `/pulses/:pulseId/retry` | owner | batch202; `{requestId,revision,confirmUncertain}` |
| POST `/test` | owner | batch202; `{requestId,channel:'slack'|'email'}`; own recipient only |

Slack callback is separate GET `/api/notifications/slack/callback?code=...&state=...` registered inside the same identity scoped plugin, with authenticated-session reads and state/nonce rather than Origin on OAuth GET. Success303redirect to fixed app `/developer-experience?workspace=<UUID>&notificationLink=success`; failures303redirect there with `notificationLink=failed` only when trusted state provides workspace, otherwise fixed `/developer-experience?notificationLink=failed`. Never echo code/state/provider errors to redirects/logs.

- [ ] Add tests through `createServer` and actual `registerIdentity`, with real fixture login and random-schema PostgreSQL. No direct parallel registration that bypasses production plugin. Missing identity503/no-store; bad Origin403; no membership/cross-workspace404; member owner action403; malicious fields400; stale revisions409. Test callback after session revocation and during config rotation.

```ts
const response = await server.inject({ method: 'POST', url: `${base}/test`, headers: memberHeaders, payload: { requestId: randomUUID(), channel: 'email' } });
expect(response.statusCode).toBe(403);
expect(response.headers['cache-control']).toBe('no-store');
expect(JSON.stringify((await ownerSummary()).json())).not.toContain(member.userId);
```

- [ ] Observe RED. Before owner enable, read/authorize current workspace, verify bot workspace outside the transaction when Slack is authorized, then pass the server-only verification proof to repository updatePolicy and recheck current authorization/configuration there. Register routes even when config absent so stored own history and unlink remain available; owner enabling/test/link-start fail safely without authorized capability. Never expose grant credentials/fingerprints or choose a recipient from supplied input. Scope all history cursors and mutate requests; maintain no-store/redacted error mapping. Availability is read-only, not proof of actual deliverability.
- [ ] Read exact pulse directly for notification-linked detail regardless of history page/deleted team. Reuse existing authorized SPACE get route; tests hidden workspace/target not-found distinguish only through fresh membership recheck in browser, not new disclosure codes.
- [ ] Configure fixed server callback URI/public origin, preserve Better Auth refresh-cookie forwarding and identity-only GitHub login. Do not log OAuth querystrings. Add owner test throttle one per initiating owner/channel/workspace per24hours with exact request replay; aggregate test status never leaks another recipient.
- [ ] Coordinator wires private config to main and verifies absent config leaves all current features healthy. Run HTTP/identity/SPACE regression suites, opposite-engine review, checks. Commit `feat(api): expose scoped notification setup and history`.

## Task 6: Owner setup, member linking and exact pulse navigation

**Files:** Create `apps/web/src/features/notifications/{api,notification-panel,setup-wizard,own-link,own-history,delivery-summary,notification-scope,view-search}.ts`/`.tsx` (data/search `.ts`, components `.tsx`); `api.test.ts`, `notification-panel.test.tsx`, `view-search.test.ts`; modify `apps/web/src/features/space/{space-page,pulse-detail}.tsx` and `apps/web/src/routes/developer-experience.tsx`. Coordinator integrates approved CSS hunks; generated route tree from build only.

**Interfaces:** Strict `parseNotificationAvailability`, `parseNotificationPolicy`, `parseOwnSlackLink`, `parseOwnNotificationPage`, `parseDeliverySummary`, `parseNotificationBatch` in web `api.ts` accept unknown and match Task5 envelopes. `NotificationPanel({workspaceId,role}:{workspaceId:string;role:'owner'|'member'})`; `PulseNotificationControls({pulseId}:{pulseId:string})` exported from `delivery-summary.tsx`; `parseNotificationSearch(value:unknown):{workspace?:string;pulse?:string;notificationLink?:'success'|'failed'}` and `DeveloperExperiencePage({initialTarget?:{workspaceId:string;pulseId?:string},now?})` augment existing page props. Search pairs reject malformed/non-UUID values, preserve valid workspace-only OAuth outcome and never accept arbitrary return URL.

- [ ] Add meaningful browser tests for owner wizard, default disabled/missing config, member link/unlink/history, owner aggregate-only status, explicit own test confirmation, uncertain batch-retry warning, workspace/role/session changes during requests and no named-recipient output. Refreshed reads must not send/queue messages.

```tsx
await user.click(screen.getByRole('button', { name: 'Refresh notification status' }));
expect(requests.filter((r) => r.method !== 'GET')).toHaveLength(0);
expect(screen.queryByText(memberEmail)).not.toBeInTheDocument();
```

- [ ] Observe RED. Four-stage wizard: integration availability → invitation/closure/reminder choices and timings → neutral previews/test-own-destination → explicit enable. Explain Slack first/email fallback and uncertain acceptance plainly. No credentials/destination editor; no test-to-roster option. Timings/minimum response privacy remain independent.
- [ ] Member link starts server-provided allowlisted Slack authorize URL; display safe fixed success/failure after callback, no provider code/token. Unlink own binding with revision; absent Slack still shows own history and verified-email fallback explanation. Dedicated mutation scope reuses session revision/role/workspace/abort fences without changing unrelated result-history behavior. Reads use existing `useStoredRead`; no generic refactor of all providers.
- [ ] Add allowlisted `validateSearch` in thin developer-experience route and select workspace only from current authorized roster. Mount linked `PulseDetail` independent of current team/page so saved older/deleted-team pulse opens directly; link contains no team selector. Changing/closing target clears URL and local state, wrong-workspace late reads never render. Signed-out view reveals no context and asks user to sign in and reopen original notification link; do not change GitHub callback routing/account linking for this slice.
- [ ] Test pulse on page2, deleted original team, unknown target, access loss, malicious search, keyboard focus after direct detail opening and back/forward target changes. Owner draft-edit callback for linked draft must select authorized current team or give honest unavailable state; notifications themselves target opened/closed pulses.
- [ ] Add responsive equal-height panels, semantic controls, focus/status/alert behavior and reduced motion; no in-memory assumed notification success. Own timeline pagination25rows resets on scope/cursor access loss, unavailable does not become zero. Update old blanket “Clio does not send messages” copy to reflect explicit configured notification behavior without claiming automatic surveys.
- [ ] Run focused web tests/typechecks/build (regenerate routeTree), opposite-engine review then full coordinator check/diff gate. Commit `feat(web): add private pulse notification setup and links`.

## Task 7: Controlled proof, operator guide and verified delivery

**Files:** Create `docs/notifications-getting-started.md`; update `README.md`, `apps/api/README.md`, `docs/{architecture,space-getting-started}.md`, approved spec/plan; add `apps/api/tests/notifications-flow.integration.ts`; coordinator edits `main.ts`, `db/migrations.ts`, root/API scripts/manifests/lockfile and a separate opt-in local capture Compose file under `infra/notifications/` if useful. No existing PostgreSQL volume/Argo runtime changes.

**Interfaces:** Root/API script `worker:notifications` points to Task4 entrypoint; documented `--once`. Controlled fixture helper lives only under API tests and returns disposable loopback SMTP server, controlled Slack/OIDC fetch fixture, captured messages and async teardown. Local guide may use this tested harness for dependency-free SMTP capture; no external capture image/tag chosen implicitly.

- [ ] Create actual random-schema full-chain cases: fixture login/workspace/team/roster → enable → open → bind signed Slack fixture → worker → actual loopback SMTP/controlled Slack → HTTP own history and aggregate status. Distinct cases prove accepted Slack produces zero SMTP; definitive refusal produces exactly one SMTP; ambiguous post acceptance produces uncertain and zero SMTP; response/cancel/revoke while paced prevents both sends. Inspect serialized public responses/private test evidence for forbidden survey content without printing credentials.

```ts
await processOneNotification(pool, config, { provider: actualBoundedFixtureProvider });
expect(capture.smtpMessages).toHaveLength(0);
expect((await ownHistory()).items[0]?.state).toBe('provider_accepted');
expect((await ownHistory()).items[0]?.channel).toBe('slack');
```

- [ ] Guide explains exact bot/identity scopes, separate consents/callbacks, private operator JSON file/permissions, SMTP TLS/sender/public origin, workspace enable/member link, reminder caps, failures/uncertain fallback, owner tests, worker/maintenance/retention and safe disable. Separate controlled transport proof from live provider acceptance, inbox delivery and source identity verification. No secrets in examples except explicitly labelled disposable fixtures. Real installation/test send needs deliberate user action; no paid provider chosen.
- [ ] Add migration readiness probes for new tables/columns, missing-config startup/identity prerequisites and safe worker shutdown. Run `pnpm check`, full `CLIO_TEST_DATABASE_URL=<existing permitted test database> pnpm test:integration`, `pnpm build` and `git diff --check`; observe actual exits, not specialist reports alone. Keep API integration file parallelism disabled.
- [ ] Apply reviewed0017 explicitly to development DB; restart API if cached ledger stale, verify200ready and existing routes. Allowed browser surface checks setup/member empty states, direct pulse navigation, keyboard and640/1024/1440 layout. If browser/screenshot policy fails, disclose exact unverified evidence; no alternative CDP/browser bypass.
- [ ] Coordinator supplies fresh complete added-file diff against actual planning base, approved spec/contracts, reported checks and named review scope to opposite-engine reviewers. Resolve material findings with bounded regressions. Most-capable final reviewer uses actual integrated source; tests remain unverified by a read-only reviewer.
- [ ] Conventional commits, authorized main push and exact-head CI inspection follow completed checks. Archive only this task's managed worktrees after ignored handoffs are preserved. Report delivered behavior, tested paths, uncertainty limits and manual live setup; do not claim real messages sent or provider acceptance without observed authorized proof.

## Plan self-review and execution handoff

Coverage mapping: event types/frozen cohorts/manual limits/clock/retention (1,4); transport limits/templates/fallback/ambiguity (2,4); Slack identity/state/session/grant fences (3,5); SMTP/provider configuration and own tests (1,2,5,7); aggregate/own privacy and disabled controls (1,5,6); exact authenticated older/deleted pulse navigation (5,6); local/real setup distinction, root gates and independent review (7). Each Review Focus condition has a named owning regression above.

Execution preserves committed coordinator/specialist workflow. Task1 stabilizes contracts/schema; Task2 then Task3 prove network/identity boundaries; Task4 integrates durable pulse behavior; Task5 exposes production routes; Task6 completes product flow; Task7 proves and delivers. Ready isolated pieces may overlap under the three-specialist limit, but no later dependency is accepted based only on copied source or unrun tests.

Status: plan proposed for maintainer review. Spec approval authorized planning; implementation begins after this written plan is reviewed. No product code/dependencies/migrations/runtime configuration changed during planning.

Primary transport references checked during planning: [Nodemailer SMTP](https://nodemailer.com/smtp), [supported pre-encrypted socket hook](https://nodemailer.com/smtp/proxies), [SMTP error metadata](https://nodemailer.com/errors). Version pins and hook feasibility are checked again during dependency integration; no dependency was installed while writing this plan.
