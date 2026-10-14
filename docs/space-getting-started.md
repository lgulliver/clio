# Developer experience: team pulses

Clio's first SPACE slice runs short, owner-controlled team pulse surveys and reports each question as a confidential team aggregate. It follows the approved design in `docs/superpowers/specs/2026-10-13-space-foundation-design.md` and the `clio.space.pulse.v1` application contract. It is not an OEMS metric, a SPACE conformance claim or a productivity score.

## Prerequisites

- The local API and web app are running with GitHub sign-in configured (see [getting started](getting-started.md)).
- The SPACE database migration has been applied explicitly to your development database. Startup never migrates.
- You belong to a workspace. Owners need at least one team, created in **Workspace → Organize teams and products**.

Optional [pulse notifications](notifications-getting-started.md) use Slack DMs first and verified-email fallback. Delivery starts disabled and requires operator configuration and owner enablement before a pulse opens. Clio never creates or opens a pulse automatically. Test fixtures stay in tests.

## Owner setup

Open **Developer experience** in the main navigation and choose a workspace.

1. **Primary teams.** Under *Owner tools*, select **Manage primary teams**. Assign each current workspace member to at most one primary team. The list shows up to 100 members per page; a page does not describe a whole team. Assignment does not grant workspace access, and each member can see their own assignment history.
2. **Reporting minimum.** Set the minimum answers needed before any question result is shown: a whole number from 3 to 1000, default 3. Changes apply only to pulses opened afterwards.
3. **Set up a pulse.** Select **Set up a pulse** and follow the four steps:
   - *Team*: choose a current team. Products and services do not subdivide survey cohorts.
   - *Period and roster*: the reference period defaults to the previous 14 UTC calendar days and must have an exclusive end no later than the start of today (UTC), so the last included day can be yesterday. **Save draft** to see the live roster size and minimum returned by the server. The review re-reads the saved draft after assignment or minimum changes; use **Refresh roster and minimum** to check again. Unsaved team or date edits must be saved before you continue. An empty roster cannot open. A roster smaller than the minimum may open, but every question stays suppressed because the roster cannot grow.
   - *Questions*: preview the eight original pilot items.
   - *Open*: **Open pulse for responses** freezes the team name, reference period, minimum, instrument and roster. If opening conflicts with another open pulse for the team, or with an overlapping open or closed pulse sharing participants, the draft stays saved and Clio explains the conflict.
4. Tell participants to open Developer experience in Clio. Drafts can be continued or cancelled from the team's pulse list. Cancelling a draft makes its captured safe context visible to workspace members; it has no response roster or results. Its details show *Team captured at cancellation* and *Team size captured at cancellation*, not a frozen roster. Drafts show *Team* and *Roster preview*.
5. When ready, open the pulse's details and select **Close pulse**, then confirm. Closing calculates results once and deletes raw answers; closed pulses cannot reopen. **Cancel pulse** publishes nothing.

## Responding

Members on an open pulse's frozen roster can respond. Eligible pulses on the current workspace history page appear under *Awaiting your response*; select a team or use older history pages to find earlier open pulses. The form shows the team at opening, the reference period (with its exclusive end), frozen roster size, minimum, how answers are reported and the member's own primary-team history. Each item defaults to *Prefer not to answer / not applicable*. Review the answers, then submit once. A fully skipped response records participation only. After acceptance the answers are cleared from the page and cannot be viewed or changed. Members who moved team after opening can still answer; people assigned later wait for the next pulse.

If response acceptance is uncertain, retrying preserves the first accepted response. Changing local answers before retrying cannot overwrite an earlier accepted response.

## Reading results

- **Engineering teams** shows each team's most recent reference period among closed pulses on the current page side by side, including teams that have since been deleted. There is no workspace total.
- Selecting a team shows its latest closed results grouped by the five SPACE dimensions, a question trend and the team's pulse list (25 per page, newest created first).
- A question with fewer answers than the frozen minimum, including none, shows **Suppressed** with no count. Published questions show the arithmetic mean on the original 1–5 scale and how many answered.
- Activity is self-reported frequency; higher is not better or worse.
- Owners see exact participation counts while open or closed; members see the closed total only when it reaches the minimum, and no response counts while a pulse is open. Cancelled pulses never show response counts.
- Trends use only pulses on the current page. Separate lines are kept for each original team and reference-period length. Lines join only touching published periods; suppressed, open and cancelled periods and unrecorded intervals break them. Expand *Chart data and context* for each point's period, recorded team name (at opening, or captured at cancellation for pulses that never opened), frozen roster or captured team size, answered count, minimum and closure time.

## Confidentiality limits

Results are confidential aggregate reporting, not anonymity. Small teams, database administrators, owners who change assignments, and people who know others' answers may still infer responses. No screen lists named responders or non-responders.

## Current limitations

- Browser visual and assistive-technology checks have not yet been recorded; behaviour is covered by jsdom tests.
- There is no scheduling, reminder, export, free-text answer, product/service drill-down or composite score.
- Repository operational signals use a separate [GitHub SPACE connection](providers/connect-space-github.md) alongside pulses: observed PR/review activity, PR review time (open to merge), and time to first human review. These provisional signals remain separate from confidential survey answers and respondent suppression. They are not combined into a productivity score.
