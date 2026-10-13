import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { errorMessage, parseWorkspaces, type Workspace } from '../identity/api';
import { useSession } from '../identity/session';
import { parseOrganization } from '../organization/api';
import { useStoredRead } from '../result-history/history-browser';
import { OperationsPanel } from '../space-github/operations-panel';
import {
  dimensions,
  instrument,
  type Pulse,
  parseInstrument,
  parsePreferences,
  parsePulsePage,
} from './api';
import { OwnAssignment } from './own-assignment';
import { AssignmentManager, MinimumSetting } from './owner-settings';
import { formatReferencePeriod } from './period';
import { PulseDetail } from './pulse-detail';
import { DimensionResults, formatMean, participation, stateLabel } from './pulse-results';
import { PulseWizard } from './pulse-wizard';
import {
  type AccessVerdict,
  readFailure,
  SpaceScopeProvider,
  useCursorRecovery,
  useSpaceRead,
  useSpaceScope,
} from './space-scope';
import { TrendChart } from './trend-chart';

type Clock = () => Date;
const systemClock: Clock = () => new Date();

export function DeveloperExperiencePage({ now = systemClock }: { now?: Clock }) {
  const session = useSession();
  return (
    <section className="delivery-dashboard space-dashboard">
      <header className="page-header">
        <h1>Developer experience</h1>
        <p>
          Team pulse surveys grouped by SPACE dimension, with each question reported separately as a
          confidential team aggregate. Pull request observations from connected GitHub repositories
          are shown separately, per repository. There is no combined productivity score.
        </p>
      </header>
      {session.status === 'ready' && session.user ? (
        <SpaceWorkspaces key={`${session.user.id}:${session.revision}`} now={now} />
      ) : (
        <div className="panel">
          <h2 className="text-xl font-semibold">Team pulses</h2>
          <p className="mt-3" role={session.status === 'checking' ? 'status' : undefined}>
            {session.status === 'checking'
              ? 'Checking your session…'
              : session.status === 'error'
                ? 'Developer experience is unavailable until your session can be checked.'
                : 'Sign in with GitHub to view team pulses.'}
          </p>
        </div>
      )}
    </section>
  );
}

function SpaceWorkspaces({ now }: { now: Clock }) {
  const query = useStoredRead('space/workspaces', '/api/workspaces', parseWorkspaces);
  const [selected, setSelected] = useState('');
  const selection = useRef('');
  const roles = useRef(new Map<string, Workspace['role']>());
  roles.current = new Map((query.data ?? []).map((item) => [item.id, item.role]));
  const [denied, setDenied] = useState('');
  const [roleChanged, setRoleChanged] = useState('');
  const [attempt, setAttempt] = useState(0);
  const verifying = useRef<Promise<readonly Workspace[] | null> | null>(null);
  const active = query.data?.find((item) => item.id === selected);
  const activeKey = active ? `${active.id}:${active.role}` : '';
  const activeId = active?.id ?? '';
  const refetchWorkspaces = query.refetch;
  const validSelection = useCallback(
    () => activeId !== '' && selection.current === activeId,
    [activeId],
  );
  const latestRole = useCallback(() => roles.current.get(activeId), [activeId]);
  /**
   * Recheck membership and role through the authenticated workspace list. Concurrent checks share
   * one request. Role refs update synchronously so pending writes from an old role stay fenced
   * before the role-scoped tree remounts. Unverifiable metadata fails closed.
   */
  const revalidate = useCallback(
    async (role: Workspace['role']): Promise<AccessVerdict> => {
      const id = activeId;
      if (!id || selection.current !== id) return 'stale';
      if (!verifying.current)
        verifying.current = refetchWorkspaces()
          .then((result) => (result.isError ? null : (result.data ?? null)))
          .catch(() => null)
          .finally(() => {
            verifying.current = null;
          });
      const workspaces = await verifying.current;
      if (selection.current !== id) return 'stale';
      if (!workspaces) {
        roles.current = new Map();
        setDenied(`${id}:${role}`);
        return 'unknown';
      }
      roles.current = new Map(workspaces.map((item) => [item.id, item.role]));
      const current = workspaces.find((item) => item.id === id);
      if (!current) return 'gone';
      if (current.role !== role) {
        setRoleChanged(id);
        return 'changed';
      }
      return 'unchanged';
    },
    [activeId, refetchWorkspaces],
  );
  if (query.isPending) return <p role="status">Loading workspaces…</p>;
  if (query.isError)
    return (
      <div className="panel">
        <p role="alert">{errorMessage(query.error)}</p>
        <button className="control mt-3" type="button" onClick={() => void query.refetch()}>
          Retry workspaces
        </button>
      </div>
    );
  return (
    <div className="space-workspace">
      {query.data.length === 0 ? (
        <p className="panel">
          No accessible workspaces. Create one or accept an invitation in Workspace.
        </p>
      ) : (
        <div className="scope-filter space-workspace-filter">
          <label htmlFor="space-workspace">Workspace</label>
          <select
            id="space-workspace"
            className="field"
            value={active?.id ?? ''}
            onChange={(event) => {
              selection.current = event.target.value;
              setDenied('');
              setRoleChanged('');
              setSelected(event.target.value);
            }}
          >
            <option value="">Choose a workspace</option>
            {query.data.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {selected && !active && (
        <p role="alert">This workspace is no longer available to you. Choose another workspace.</p>
      )}
      {active &&
        (denied === activeKey ? (
          <div className="panel" role="alert">
            <p>
              Your access to {active.name} could not be confirmed. Private developer experience data
              stays hidden until access is checked again.
            </p>
            <button
              className="control mt-3"
              type="button"
              onClick={() => {
                setDenied('');
                setAttempt((value) => value + 1);
              }}
            >
              Check access again
            </button>
          </div>
        ) : (
          <>
            {roleChanged === active.id && (
              <p role="status" className="space-note">
                Your access to {active.name} changed. Showing what your current role ({active.role})
                can see.
              </p>
            )}
            <SpaceScopeProvider
              key={`${activeKey}:${attempt}`}
              workspace={active}
              validSelection={validSelection}
              latestRole={latestRole}
              revalidate={revalidate}
            >
              <SpaceDashboard now={now} />
            </SpaceScopeProvider>
          </>
        ))}
    </div>
  );
}

type TeamChoice = { id: string; name: string; current: boolean };

function latestClosed(pulses: readonly Pulse[], teamId: string) {
  return pulses
    .filter((item) => item.teamId === teamId && item.state === 'closed')
    .sort(
      (a, b) =>
        Date.parse(b.referenceStart) - Date.parse(a.referenceStart) ||
        Date.parse(b.closedAt ?? '') - Date.parse(a.closedAt ?? ''),
    )[0];
}

function SpaceDashboard({ now }: { now: Clock }) {
  const scope = useSpaceScope();
  const id = useId();
  const workspaceId = scope.workspace.id;
  const [cursor, setCursor] = useState<string | undefined>();
  const [team, setTeam] = useState<TeamChoice | null>(null);
  const [pulseId, setPulseId] = useState('');
  const selectedPulse = useRef('');
  const [wizard, setWizard] = useState<{ draft: Pulse | null; key: number } | null>(null);
  const wizardTrigger = useRef<HTMLButtonElement>(null);
  const [assignmentsOpen, setAssignmentsOpen] = useState(false);
  const scopeHeading = useRef<HTMLHeadingElement>(null);
  const focusScope = useRef(false);
  const instrumentQuery = useSpaceRead('instrument', `${scope.path}/instrument`, parseInstrument);
  const preferences = useSpaceRead('preferences', `${scope.path}/preferences`, (value) =>
    parsePreferences(value, workspaceId),
  );
  const organization = useSpaceRead(
    'organization',
    `/api/workspaces/${workspaceId}/organization`,
    (value) => parseOrganization(value, workspaceId),
  );
  const all = useSpaceRead(
    `pulses/all/${cursor ?? ''}`,
    `${scope.path}/pulses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    (value) =>
      parsePulsePage(value, {
        workspaceId,
        role: scope.workspace.role,
        ...(cursor ? { cursor } : {}),
      }),
  );
  const [pageNotice, setPageNotice] = useState('');
  useCursorRecovery(all.missing, cursor, () => {
    setCursor(undefined);
    setPageNotice('That page of pulses is no longer available. Showing the newest pulses.');
  });
  useEffect(() => {
    if (focusScope.current) scopeHeading.current?.focus();
    focusScope.current = false;
  });
  const currentTeams = organization.data?.teams ?? [];
  const choices = useMemo(() => {
    const current = (organization.data?.teams ?? []).map((item) => ({
      id: item.id,
      name: item.name,
      current: true,
    }));
    const known = new Set(current.map((item) => item.id));
    const archived = new Map<string, TeamChoice>();
    for (const item of all.data?.pulses ?? [])
      if (!known.has(item.teamId) && !archived.has(item.teamId))
        archived.set(item.teamId, { id: item.teamId, name: item.teamName, current: false });
    if (team && !team.current && !archived.has(team.id)) archived.set(team.id, team);
    return [...current, ...archived.values()];
  }, [organization.data, all.data, team]);
  const currentNames = useMemo(
    () => new Map(currentTeams.map((item) => [item.id, item.name])),
    [currentTeams],
  );
  const stillPulse = useCallback(
    (expected: string) => () => selectedPulse.current === expected,
    [],
  );
  /** Buttons move focus to the new scope heading; the Team selector keeps keyboard focus. */
  function selectTeam(next: TeamChoice | null, pulse = '', focus = true) {
    selectedPulse.current = pulse;
    setPulseId(pulse);
    setTeam(next);
    focusScope.current = focus;
  }
  function selectPulse(next: string) {
    selectedPulse.current = next;
    setPulseId(next);
  }
  function openWizard(draft: Pulse | null) {
    setWizard((current) => ({ draft, key: (current?.key ?? 0) + 1 }));
  }
  const roots = [instrumentQuery, preferences, organization];
  if (roots.some((item) => item.checking)) return <p role="status">Checking access…</p>;
  const failure = roots.find((item) => item.isError);
  if (failure)
    return (
      <div className="panel">
        <p role="alert">
          {readFailure(failure, 'Developer experience details are unavailable right now.')}
        </p>
        <button
          className="control mt-3"
          type="button"
          onClick={() => {
            for (const item of [instrumentQuery, preferences, organization])
              if (item.isError) void item.refetch();
          }}
        >
          Retry developer experience
        </button>
      </div>
    );
  if (!instrumentQuery.data || !preferences.data || !organization.data)
    return <p role="status">Loading developer experience…</p>;
  // A replacement page loads in place so the wizard and owner forms stay mounted.
  const page = all.data ?? { pulses: [], nextCursor: null };
  const awaiting = page.pulses.filter(
    (item) => item.state === 'open' && item.eligible && !item.submitted,
  );
  const selectedChoice = team ? (choices.find((item) => item.id === team.id) ?? team) : null;
  return (
    <div className="space-layout">
      <div className="space-scope-bar">
        <label htmlFor={`${id}-team`}>Team</label>
        <select
          id={`${id}-team`}
          className="field"
          value={selectedChoice?.id ?? ''}
          onChange={(event) => {
            const next = choices.find((item) => item.id === event.target.value) ?? null;
            selectTeam(next, '', false);
          }}
        >
          <option value="">All engineering teams</option>
          {choices.map((item) => (
            <option key={item.id} value={item.id}>
              {item.current ? item.name : `${item.name} (team deleted)`}
            </option>
          ))}
        </select>
        <p className="space-muted">
          Reporting minimum for new pulses: {preferences.data}. Instrument{' '}
          {instrumentQuery.data.version} ({instrument.questions.length} original items).
        </p>
      </div>
      {awaiting.length > 0 && (
        <section className="space-awaiting" aria-label="Pulses awaiting your response">
          <h2>Awaiting your response</h2>
          <p className="space-muted">
            Eligible open pulses on the current workspace history page. Use team pulse history or
            older workspace pages to find earlier pulses.
          </p>
          <ul>
            {awaiting.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() =>
                    selectTeam(
                      {
                        id: item.teamId,
                        name: currentNames.get(item.teamId) ?? item.teamName,
                        current: currentNames.has(item.teamId),
                      },
                      item.id,
                    )
                  }
                >
                  Respond to {item.teamName} pulse
                  <span>{formatReferencePeriod(item.referenceStart, item.referenceEnd)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {scope.owner && wizard && (
        <PulseWizard
          key={wizard.key}
          teams={currentTeams}
          draft={wizard.draft}
          now={now}
          onClose={() => {
            setWizard(null);
            wizardTrigger.current?.focus();
          }}
        />
      )}
      <h2 ref={scopeHeading} tabIndex={-1} className="scope-title">
        {selectedChoice ? selectedChoice.name : 'Engineering teams'}
        {selectedChoice && !selectedChoice.current && (
          <span className="space-chip">Team deleted</span>
        )}
      </h2>
      {selectedChoice ? (
        <TeamView
          key={selectedChoice.id}
          team={selectedChoice}
          currentNames={currentNames}
          pulseId={pulseId}
          onSelectPulse={selectPulse}
          stillPulse={stillPulse}
          onEditDraft={openWizard}
        />
      ) : all.data ? (
        <EngineeringSummary
          pulses={page.pulses}
          choices={choices}
          hasOlder={page.nextCursor !== null}
          onSelect={(choice) => selectTeam(choice)}
        />
      ) : all.isError && !all.checking && !(all.missing && cursor !== undefined) ? (
        <div className="panel">
          <p role="alert">{readFailure(all, 'Team pulses are unavailable right now.')}</p>
          <button className="control mt-3" type="button" onClick={() => void all.refetch()}>
            Retry team pulses
          </button>
        </div>
      ) : (
        <p role="status">Loading team pulses…</p>
      )}
      {!selectedChoice && pageNotice && <p role="status">{pageNotice}</p>}
      {!selectedChoice && (
        <div className="space-pager">
          <button
            type="button"
            className="space-secondary"
            aria-disabled={cursor === undefined}
            onClick={() => {
              if (cursor === undefined) return;
              setPageNotice('');
              setCursor(undefined);
            }}
          >
            Newest pulses
          </button>
          <button
            type="button"
            className="space-secondary"
            aria-disabled={!all.data?.nextCursor || all.isFetching}
            onClick={() => {
              if (!page.nextCursor || all.isFetching) return;
              setPageNotice('');
              setCursor(page.nextCursor);
            }}
          >
            Older pulses
          </button>
        </div>
      )}
      <OperationsPanel
        workspaceId={workspaceId}
        role={scope.workspace.role}
        teamId={selectedChoice?.id}
        teamName={selectedChoice?.name}
        teams={currentTeams}
        now={now}
        onTeamSelect={(choice) => {
          // Copied result ownership feeds the existing team choice; deleted teams stay history.
          const current = currentNames.get(choice.id);
          selectTeam(
            current === undefined
              ? { id: choice.id, name: choice.name, current: false }
              : { id: choice.id, name: current, current: true },
          );
        }}
      />
      <div className="space-side">
        <OwnAssignment />
        {scope.owner && (
          <section className="panel space-owner" aria-labelledby={`${id}-owner`}>
            <h3 id={`${id}-owner`}>Owner tools</h3>
            <p className="space-muted">
              Pulses open only when you choose. Clio does not schedule pulses or send messages.
            </p>
            <button
              ref={wizardTrigger}
              type="button"
              className="control"
              aria-expanded={wizard !== null}
              onClick={() => openWizard(null)}
            >
              Set up a pulse
            </button>
            <MinimumSetting minimum={preferences.data} />
            <button
              type="button"
              className="space-disclosure"
              aria-expanded={assignmentsOpen}
              aria-controls={`${id}-assignments`}
              onClick={() => setAssignmentsOpen((open) => !open)}
            >
              Manage primary teams
            </button>
            <div id={`${id}-assignments`}>
              {assignmentsOpen && <AssignmentManager teams={currentTeams} />}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function CompactResults({ pulse }: { pulse: Pulse }) {
  const results = pulse.questions ?? [];
  return (
    <dl className="space-compact-results">
      {dimensions.map((dimension) => (
        <div key={dimension.id}>
          <dt>{dimension.label}</dt>
          {instrument.questions
            .filter((question) => question.dimension === dimension.id)
            .map((question) => {
              const result = results.find((item) => item.questionId === question.id);
              return (
                <dd key={question.id}>
                  <span>{question.prompt}</span>
                  <strong>
                    {result?.status === 'published' ? formatMean(result.mean) : 'Suppressed'}
                  </strong>
                </dd>
              );
            })}
        </div>
      ))}
    </dl>
  );
}

function EngineeringSummary({
  pulses,
  choices,
  hasOlder,
  onSelect,
}: {
  pulses: readonly Pulse[];
  choices: readonly TeamChoice[];
  hasOlder: boolean;
  onSelect: (choice: TeamChoice) => void;
}) {
  const scope = useSpaceScope();
  return (
    <section aria-label="Engineering team summaries">
      <p className="space-muted">
        Each team&apos;s most recent closed pulse among the {pulses.length} most recently created
        pulses on this page{hasOlder ? '; older pulses are on later pages' : ''}. Teams are shown
        side by side and never combined into a workspace total.
      </p>
      {choices.length === 0 ? (
        <p>No teams yet. Owners can create teams in Workspace.</p>
      ) : (
        <ul className="space-team-grid">
          {choices.map((choice) => {
            const latest = latestClosed(pulses, choice.id);
            const open = pulses.some((item) => item.teamId === choice.id && item.state === 'open');
            return (
              <li key={choice.id} className="space-team-card">
                <div className="space-team-card-heading">
                  <h3>{choice.name}</h3>
                  {!choice.current && <span className="space-chip">Team deleted</span>}
                  {open && <span className="space-chip">Pulse open</span>}
                </div>
                {latest ? (
                  <>
                    <p className="space-muted">
                      {formatReferencePeriod(latest.referenceStart, latest.referenceEnd)}
                      {latest.teamName !== choice.name ? ` · recorded as ${latest.teamName}` : ''}
                    </p>
                    <p className="space-muted">{participation(latest, scope.owner)}</p>
                    <CompactResults pulse={latest} />
                  </>
                ) : (
                  <p className="space-muted">No closed pulse for this team on this page.</p>
                )}
                <button type="button" className="text-action" onClick={() => onSelect(choice)}>
                  View {choice.name} pulses
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function TeamView({
  team,
  currentNames,
  pulseId,
  onSelectPulse,
  stillPulse,
  onEditDraft,
}: {
  team: TeamChoice;
  currentNames: ReadonlyMap<string, string>;
  pulseId: string;
  onSelectPulse: (id: string) => void;
  stillPulse: (id: string) => () => boolean;
  onEditDraft: (pulse: Pulse) => void;
}) {
  const scope = useSpaceScope();
  const [cursor, setCursor] = useState<string | undefined>();
  const query = useSpaceRead(
    `pulses/team/${team.id}/${cursor ?? ''}`,
    `${scope.path}/pulses?teamId=${team.id}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    (value) =>
      parsePulsePage(value, {
        workspaceId: scope.workspace.id,
        role: scope.workspace.role,
        teamId: team.id,
        ...(cursor ? { cursor } : {}),
      }),
  );
  const [notice, setNotice] = useState('');
  useCursorRecovery(query.missing, cursor, () => {
    onSelectPulse('');
    setCursor(undefined);
    setNotice('That page of team pulses is no longer available. Showing the newest pulses.');
  });
  if (query.isPending || query.checking || (query.missing && cursor !== undefined))
    return <p role="status">Loading team pulses…</p>;
  if (query.isError)
    return (
      <div className="panel">
        <p role="alert">{readFailure(query, 'Pulses for this team are unavailable right now.')}</p>
        <button className="control mt-3" type="button" onClick={() => void query.refetch()}>
          Retry team pulses
        </button>
      </div>
    );
  const page = query.data;
  const latest = latestClosed(page.pulses, team.id);
  return (
    <div className="space-team-view">
      <section className="panel" aria-label="Latest closed results">
        <h3 className="space-panel-title">Latest closed pulse on this page</h3>
        {latest ? (
          <>
            <p className="space-muted">
              {latest.teamName} ·{' '}
              {formatReferencePeriod(latest.referenceStart, latest.referenceEnd)} ·{' '}
              {participation(latest, scope.owner)}
            </p>
            <DimensionResults pulse={latest} headingLevel={4} />
          </>
        ) : (
          <p>
            No closed pulse for this team on this page. Results appear after an owner closes a
            pulse.
          </p>
        )}
      </section>
      <div className="panel">
        <TrendChart
          pulses={page.pulses}
          currentTeamNames={currentNames}
          hasOlder={page.nextCursor !== null}
        />
      </div>
      <section className="panel" aria-label={`${team.name} pulses`}>
        <h3 className="space-panel-title">Pulses</h3>
        {page.pulses.length === 0 ? (
          <p>{cursor ? 'No pulses on this older page.' : 'No pulses for this team yet.'}</p>
        ) : (
          <div className="comparison-scroll">
            <table className="space-table">
              <caption>Up to 25 pulses per page, newest created first</caption>
              <thead>
                <tr>
                  <th scope="col">Reference period</th>
                  <th scope="col">State</th>
                  <th scope="col">Team name recorded</th>
                  <th scope="col">Participation</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {page.pulses.map((item) => (
                  <tr key={item.id}>
                    <th scope="row">
                      {formatReferencePeriod(item.referenceStart, item.referenceEnd)}
                    </th>
                    <td>{stateLabel(item.state)}</td>
                    <td>{item.teamName}</td>
                    <td>{participation(item, scope.owner)}</td>
                    <td>
                      <button
                        type="button"
                        className="text-action"
                        aria-pressed={pulseId === item.id}
                        aria-label={`${
                          item.state === 'open' && item.eligible && !item.submitted
                            ? 'Respond to'
                            : 'View'
                        } pulse for ${formatReferencePeriod(item.referenceStart, item.referenceEnd)}`}
                        onClick={() => onSelectPulse(item.id)}
                      >
                        {item.state === 'open' && item.eligible && !item.submitted
                          ? 'Respond'
                          : 'View'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="space-pager">
          <button
            type="button"
            className="space-secondary"
            aria-disabled={cursor === undefined}
            onClick={() => {
              if (cursor === undefined) return;
              onSelectPulse('');
              setCursor(undefined);
            }}
          >
            Newest team pulses
          </button>
          <button
            type="button"
            className="space-secondary"
            aria-disabled={!page.nextCursor || query.isFetching}
            onClick={() => {
              if (!page.nextCursor || query.isFetching) return;
              onSelectPulse('');
              setNotice('');
              setCursor(page.nextCursor);
            }}
          >
            Older team pulses
          </button>
        </div>
        {notice && <p role="status">{notice}</p>}
      </section>
      {pulseId && (
        <PulseDetail
          key={pulseId}
          pulseId={pulseId}
          still={stillPulse(pulseId)}
          onEditDraft={onEditDraft}
        />
      )}
    </div>
  );
}
