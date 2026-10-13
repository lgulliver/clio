# SPACE pulse HTTP contract

All endpoints use `/api/workspaces/:workspaceId/space`. Current database session and workspace membership are required on every request. Writes require the exact configured trusted Origin. Owner operations require the current owner role. All responses have `Cache-Control: no-store`. No endpoint returns raw answers, roster identities or other people's submission flags. Current primary assignments are separate from private pulse rosters.

Bodies and query objects accept only the fields below. UUIDs use canonical lowercase form. Empty mutation bodies must be `{}`. Errors are redacted `{error:"invalid_request"|"unauthorized"|"forbidden"|"not_found"|"conflict"|"unavailable"}` with 400/401/403/404/409/503 respectively. Missing membership or another workspace's target returns 404; current non-owner on owner actions returns 403. No conflict/error echoes submitted answers.

| Method/path | Body/query | Success |
| --- | --- | --- |
| GET `/instrument` | no query | `{instrument}` |
| GET `/preferences` | no query | `{workspaceId,minimumRespondents}` |
| PATCH `/preferences` (owner) | `{minimumRespondents}` | same |
| GET `/assignments` (owner) | optional `cursor` current member user ID | `{workspaceId,assignments:[{userId,teamId:UUID|null,teamName:string|null}],nextCursor:string|null}`; max 100 |
| POST `/assignments/:userId` (owner) | `{teamId:UUID|null}` | `{workspaceId,assignment:{userId,teamId,teamName}}` |
| GET `/assignment` | optional `cursor` history UUID | `{workspaceId,teamId:UUID|null,teamName:string|null,history:[{id,teamId:UUID|null,teamName:string|null,changedAt:UTC}],nextCursor:UUID|null}`; own history only, max 25 |
| POST `/pulses` (owner) | `{teamId,referenceStart,referenceEnd}` | 201 `{pulse}` draft |
| PATCH `/pulses/:pulseId` (owner) | `{teamId,referenceStart,referenceEnd}` | `{pulse}` editable draft only |
| GET `/pulses` | optional `teamId` original team UUID and `cursor` last pulse UUID | `{workspaceId,pulses:Pulse[],nextCursor:UUID|null}`; max 25 |
| GET `/pulses/:pulseId` | no query | `{pulse}` |
| POST `/pulses/:pulseId/open` (owner) | `{}` | `{pulse}` |
| POST `/pulses/:pulseId/close` (owner) | `{}` | `{pulse}`; repeated close returns immutable result |
| POST `/pulses/:pulseId/cancel` (owner) | `{}` | `{pulse}`; repeated cancel returns context |
| POST `/pulses/:pulseId/response` | `{instrumentVersion:"clio.space.pulse.v1",answers:{all eight question IDs:integer1–5|null}}` | `{workspaceId,pulseId,submitted:true}` |

Assignment list user IDs identify current workspace members for owner assignment management, never frozen roster members or responders. Reuse the existing owner-only `/api/workspaces/:workspaceId/members` for names. Assignment change history includes automatic clearing on team deletion/membership removal and preserves the copied team name. All history cursors belong to the current workspace/actor/filter; a mismatched or no-longer-visible cursor returns 404. Pages replace each other; no unbounded download endpoint exists.

The instrument is `{version:"clio.space.pulse.v1",questions:[{id,prompt,dimension,scale:"agreement"|"frequency"}],scales:{agreement:string[5],frequency:string[5]}}`. Dimensions are `satisfaction_and_wellbeing`, `performance`, `activity`, `communication_and_collaboration`, `efficiency_and_flow`. Question IDs in order: `satisfaction`, `sustainable_workload`, `useful_outcomes`, `contribution_frequency`, `useful_help`, `shared_context`, `effective_tools`, `focus_time`. The prompts and labels are the original eight items in the approved design. All eight answer keys are mandatory, even for skipped items (`null`). No user ID, free text, receipt ID or timestamp is accepted in responses.

`Pulse` has exactly these fields:

```ts
{
  id: string; workspaceId: string; teamId: string; teamName: string;
  instrumentVersion: 'clio.space.pulse.v1';
  referenceStart: string; referenceEnd: string;
  state: 'draft' | 'open' | 'closed' | 'cancelled';
  minimumRespondents: number; rosterSize: number;
  openedAt: string | null; closedAt: string | null; cancelledAt: string | null;
  eligible: boolean; submitted: boolean;
  submittedCount: number | null;
  questions: null | Array<
    {questionId: string; status: 'suppressed'; mean: null} |
    {questionId: string; status: 'published'; mean: number; answeredCount: number}
  >;
}
```

Reference bounds are UTC calendar midnights, canonical `YYYY-MM-DDT00:00:00.000Z`; end is exclusive, start precedes end, and end cannot exceed the current UTC midnight. Owners choose them before opening; the browser defaults to the preceding 14 UTC calendar days. Minimum is integer 3–1000, default 3. Draft minimum/roster size are live previews; team name is current until opening. Opening freezes minimum, reference period, exact stable-user roster, denominator and copied team name. Empty roster is rejected. One open pulse per team; half-open reference periods cannot overlap open/closed pulses sharing any participants across teams. Cancelled pulses do not reserve periods.

Drafts are owner-only; member lists omit them and direct reads return 404. Lists sort newest creation tuple first and include open, closed and cancelled pulses (plus drafts for owners); filtering uses the original team identity, including deleted teams. `questions` is null outside closed state. Open counts are exact for owners and null for members; closed total counts are exact for owners and visible to members only at/above frozen minimum. Cancelled counts are always null. Cancelling a never-opened draft makes its captured safe context visible to workspace members; it has no eligible roster, receipts or results. Below-minimum question counts, including zero, are uniformly `{questionId,status:"suppressed",mean:null}` for everyone, without `answeredCount`. Published questions use the arithmetic mean of non-null answers and exact answeredCount. No dimension or overall score exists.

`eligible` reports only the current actor's frozen roster eligibility while current membership holds; draft is false. `submitted` reports only the actor's receipt state. An already accepted receipt returns the same response success for any valid replacement body, including after closure/cancellation, after rechecking current session, membership and frozen-roster eligibility. It never compares, replaces or echoes answers. A new response requires an open pulse. Closing/cancelling purges all raw answer rows in the same authorized transaction. Immutable closed results, private roster and unlinked receipts remain. A moved member retains frozen eligibility; revoked members cannot read/write; the same stable user rejoining retains the receipt fence. A different account with the same email does not inherit eligibility.

Team deletion returns 409 while draft/open pulses exist. Closed/cancelled original team ID/name survive deletion, and current primary assignments clear. Survey results are confidential aggregate reporting; they do not promise anonymity from administrators, malicious owners or respondents who know others' answers.
