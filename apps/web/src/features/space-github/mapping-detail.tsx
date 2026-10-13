import { useEffect, useId, useRef, useState } from 'react';
import { ApiError, errorMessage } from '../identity/api';
import type { Team } from '../organization/api';
import {
  defaultReferenceInputs,
  formatReferencePeriod,
  periodLengthDays,
  referenceFromInputs,
} from '../space/period';
import { readFailure, useSpaceScope } from '../space/space-scope';
import {
  type OperationMapping,
  type OperationResult,
  type OperationRun,
  parseOperationMapping,
  parseOperationRun,
} from './api';
import { useCollectIntents } from './collect-intents';
import { LatestStatus, ResultHistory, RunHistory, useResultPage, useRunPage } from './history';
import { type HistoricalTeam, ResultCards } from './result-cards';
import { OperationalTrendChart } from './trend-chart';

export const staleConnectionText =
  'This connection changed since it was loaded, for example another owner reassigned or disconnected it. Refresh saved results and review it before trying again.';
export const missingConnectionText =
  'This repository connection is no longer available. Refresh the list.';

function status(error: unknown) {
  return error instanceof ApiError ? error.status : 0;
}

/** Owner-only explicit collection for one closed UTC calendar-day window (at most 90 days). */
export function CollectWindow({
  mapping,
  now,
  still,
  onQueued,
}: {
  mapping: OperationMapping;
  now: () => Date;
  still: () => boolean;
  onQueued: (run: OperationRun) => void;
}) {
  const scope = useSpaceScope();
  const id = useId();
  const initial = defaultReferenceInputs(now());
  const [firstDay, setFirstDay] = useState(initial.firstDay);
  const [lastDay, setLastDay] = useState(initial.lastDay);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState('');
  // One request ID per source revision and window, kept until the server confirms it: retrying an
  // uncertain enqueue, even after another window or a closed view, cannot queue twice.
  const intents = useCollectIntents();
  const bounds = referenceFromInputs(firstDay, lastDay, now());
  const invalid =
    'error' in bounds
      ? bounds.error
      : periodLengthDays(bounds.referenceStart, bounds.referenceEnd) > 90
        ? 'Choose a window of at most 90 days.'
        : '';
  async function collect() {
    if ('error' in bounds || invalid) return;
    setError('');
    const window = { windowStart: bounds.referenceStart, windowEnd: bounds.referenceEnd };
    const requestId = intents.requestId(mapping, window);
    const body = { revision: mapping.revision, requestId, ...window };
    const outcome = await scope.mutate({
      path: `/github/mappings/${mapping.id}/runs`,
      body,
      parse: (value) =>
        parseOperationRun(value, {
          workspaceId: scope.workspace.id,
          mappingId: mapping.id,
          mappingRevision: mapping.revision,
          ...window,
        }),
      owner: true,
      still,
    });
    if (outcome.status === 'stale') return;
    setConfirming(false);
    if (outcome.status === 'failed') {
      const code = status(outcome.error);
      setError(
        code === 409
          ? staleConnectionText
          : code === 404
            ? missingConnectionText
            : code === 0 || code >= 500
              ? 'The collection request could not be confirmed. Refresh saved results to check for a queued run. Trying the same window again reuses this request, so it cannot queue twice.'
              : errorMessage(outcome.error),
      );
      scope.refresh();
      return;
    }
    intents.resolve(mapping, window, requestId);
    onQueued(outcome.value);
    scope.refresh();
  }
  return (
    <div className="space-wizard-body">
      <p className="space-muted">
        Closed UTC calendar days, ending before today, up to 90 days. Collection runs in the
        background and only when you confirm it.
      </p>
      <div className="space-date-fields">
        <label>
          First day (UTC)
          <input
            className="field"
            type="date"
            value={firstDay}
            readOnly={scope.busy}
            onChange={(event) => {
              setConfirming(false);
              setFirstDay(event.target.value);
            }}
          />
        </label>
        <label>
          Last day (UTC, inclusive)
          <input
            className="field"
            type="date"
            value={lastDay}
            readOnly={scope.busy}
            onChange={(event) => {
              setConfirming(false);
              setLastDay(event.target.value);
            }}
          />
        </label>
      </div>
      {invalid && (
        <p className="space-warning" id={`${id}-invalid`}>
          {invalid}
        </p>
      )}
      {!confirming ? (
        <button
          type="button"
          className="control"
          aria-disabled={invalid !== '' || scope.busy}
          aria-describedby={invalid ? `${id}-invalid` : undefined}
          onClick={() => {
            if (!invalid && !scope.busy) setConfirming(true);
          }}
        >
          Collect this window
        </button>
      ) : (
        'referenceStart' in bounds && (
          <fieldset className="space-confirm">
            <legend>
              Queue collection of {mapping.repositoryLabel} for{' '}
              {formatReferencePeriod(bounds.referenceStart, bounds.referenceEnd)}?
            </legend>
            <button
              type="button"
              className="control"
              aria-disabled={scope.busy}
              onClick={() => {
                if (!scope.busy) void collect();
              }}
            >
              Confirm collection
            </button>
            <button type="button" className="space-secondary" onClick={() => setConfirming(false)}>
              Do not collect
            </button>
          </fieldset>
        )
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

function OwnerActions({
  mapping,
  teams,
  enabled,
  now,
  still,
  onChanged,
}: {
  mapping: OperationMapping;
  teams: readonly Team[];
  /** Collection and reassignment need workspace configuration; disconnecting never does. */
  enabled: boolean;
  now: () => Date;
  still: () => boolean;
  onChanged: (mapping: OperationMapping) => void;
}) {
  const scope = useSpaceScope();
  const id = useId();
  const [teamId, setTeamId] = useState('');
  const [confirm, setConfirm] = useState<'team' | 'disconnect' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const others = teams.filter((item) => item.id !== mapping.teamId);
  const target = others.find((item) => item.id === teamId);
  function failed(error: unknown) {
    const code = status(error);
    setError(
      code === 409
        ? staleConnectionText
        : code === 404
          ? missingConnectionText
          : code === 0 || code >= 500
            ? 'The change could not be confirmed. Refresh saved results before trying again.'
            : errorMessage(error),
    );
    scope.refresh();
  }
  async function reassign() {
    if (!target) return;
    setError('');
    setNotice('');
    const outcome = await scope.mutate({
      path: `/github/mappings/${mapping.id}`,
      method: 'PATCH',
      body: { revision: mapping.revision, teamId: target.id },
      parse: (value) => {
        const next = parseOperationMapping(value, {
          workspaceId: scope.workspace.id,
          mappingId: mapping.id,
        });
        if (next.teamId !== target.id || next.revision <= mapping.revision || !next.connected)
          throw new ApiError(0);
        return next;
      },
      owner: true,
      still,
    });
    if (outcome.status === 'stale') return;
    setConfirm(null);
    if (outcome.status === 'failed') return failed(outcome.error);
    setTeamId('');
    setNotice(
      `Now owned by ${outcome.value.teamName}. Saved results keep the team recorded when they were collected.`,
    );
    onChanged(outcome.value);
    scope.refresh();
  }
  async function disconnect() {
    setError('');
    setNotice('');
    const outcome = await scope.mutate({
      path: `/github/mappings/${mapping.id}/disconnect`,
      body: { revision: mapping.revision },
      parse: (value) => {
        const next = parseOperationMapping(value, {
          workspaceId: scope.workspace.id,
          mappingId: mapping.id,
        });
        if (next.connected) throw new ApiError(0);
        return next;
      },
      owner: true,
      still,
    });
    if (outcome.status === 'stale') return;
    setConfirm(null);
    if (outcome.status === 'failed') return failed(outcome.error);
    setNotice('Disconnected. Pending collection is cancelled; saved results remain readable.');
    onChanged(outcome.value);
    scope.refresh();
  }
  return (
    <section className="space-owner" aria-labelledby={`${id}-owner`}>
      <h4 id={`${id}-owner`} className="space-panel-title">
        Owner actions
      </h4>
      {mapping.connected && !enabled && (
        <p className="space-muted">
          Collection is not set up for this workspace, so this connection cannot collect now. You
          can still disconnect it.
        </p>
      )}
      {mapping.connected && enabled && (
        <>
          <h5 className="space-muted">Collect a window</h5>
          <CollectWindow
            key={`${mapping.id}:${mapping.revision}`}
            mapping={mapping}
            now={now}
            still={still}
            onQueued={() =>
              setNotice('Collection queued. Use Refresh saved results to check progress.')
            }
          />
          {others.length > 0 && (
            <div className="space-wizard-body mt-4">
              <label htmlFor={`${id}-team`}>Change owning team</label>
              <select
                id={`${id}-team`}
                className="field"
                value={teamId}
                disabled={scope.busy}
                onChange={(event) => {
                  setConfirm(null);
                  setTeamId(event.target.value);
                }}
              >
                <option value="">Choose a team</option>
                {others.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="space-secondary"
                aria-disabled={!target || scope.busy}
                onClick={() => {
                  if (target && !scope.busy) setConfirm('team');
                }}
              >
                Change owner
              </button>
            </div>
          )}
          {confirm === 'team' && target && (
            <fieldset className="space-confirm">
              <legend>
                Move {mapping.repositoryLabel} from {mapping.teamName} to {target.name}? Pending
                collection is cancelled; saved results stay with {mapping.teamName}.
              </legend>
              <button
                type="button"
                className="control"
                aria-disabled={scope.busy}
                onClick={() => {
                  if (!scope.busy) void reassign();
                }}
              >
                Confirm owner change
              </button>
              <button type="button" className="space-secondary" onClick={() => setConfirm(null)}>
                Keep current owner
              </button>
            </fieldset>
          )}
        </>
      )}
      {mapping.connected &&
        (confirm !== 'disconnect' ? (
          <button
            type="button"
            className="space-secondary space-danger mt-4"
            onClick={() => setConfirm('disconnect')}
          >
            Disconnect repository
          </button>
        ) : (
          <fieldset className="space-confirm">
            <legend>
              Disconnect {mapping.repositoryLabel}? Pending collection is cancelled. Saved results
              remain readable.
            </legend>
            <button
              type="button"
              className="control space-danger-fill"
              aria-disabled={scope.busy}
              onClick={() => {
                if (!scope.busy) void disconnect();
              }}
            >
              Confirm disconnect
            </button>
            <button type="button" className="space-secondary" onClick={() => setConfirm(null)}>
              Stay connected
            </button>
          </fieldset>
        ))}
      {!mapping.connected && (
        <p className="space-muted">Disconnected sources cannot collect. Saved results remain.</p>
      )}
      {scope.busy && <p role="status">Saving…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/**
 * One repository connection: current (or last-known) owner, latest run/result states, saved
 * result cards, qualified trend points and bounded history. With a team filter, history shows only
 * results/runs recorded for that team; the current owner is shown separately and never compared.
 */
export function MappingDetail({
  mapping: listed,
  teamFilter,
  teams,
  enabled,
  now,
  onTeamSelect,
  onClose,
  focus = false,
  onFocused,
}: {
  mapping: OperationMapping;
  teamFilter: { id: string; name: string } | undefined;
  teams: readonly Team[];
  enabled: boolean;
  now: () => Date;
  onTeamSelect?: ((team: HistoricalTeam) => void) | undefined;
  onClose: () => void;
  /** Move focus to the heading on mount only when the user opened this repository. */
  focus?: boolean;
  onFocused?: (() => void) | undefined;
}) {
  const scope = useSpaceScope();
  const id = useId();
  const initialFocus = useRef(focus);
  const focused = useRef(onFocused);
  const alive = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    alive.current = true;
    if (initialFocus.current) {
      heading.current?.focus();
      focused.current?.();
    }
    return () => {
      alive.current = false;
    };
  }, []);
  const [local, setLocal] = useState<OperationMapping | null>(null);
  const mapping = local && local.revision >= listed.revision ? local : listed;
  const [allHistory, setAllHistory] = useState(false);
  const filter = teamFilter && !allHistory ? teamFilter.id : undefined;
  const runs = useRunPage(mapping.id, filter);
  const results = useResultPage(mapping.id, filter);
  const [selected, setSelected] = useState<OperationResult | null>(null);
  const newest = results.data?.results[0];
  const shown =
    selected && selected.mappingId === mapping.id && (!filter || selected.teamId === filter)
      ? selected
      : newest;
  const currentTeamIds = new Set(teams.map((item) => item.id));
  const reads = [runs, results];
  const missing = reads.some((read) => read.missing);
  const failure = reads.find((read) => read.isError && !read.checking && !read.missing);
  const still = () => alive.current;
  return (
    <section className="panel space-github-detail" aria-labelledby={`${id}-title`}>
      <div className="space-section-heading">
        <h3 id={`${id}-title`} ref={heading} tabIndex={-1} className="scope-title">
          {mapping.repositoryLabel}
        </h3>
        <button type="button" className="space-secondary" onClick={onClose}>
          Close repository
        </button>
      </div>
      <p className="space-muted">
        {mapping.connected ? (
          <span className="space-chip">Connected</span>
        ) : (
          <span className="space-chip">Disconnected</span>
        )}{' '}
        {teamFilter && mapping.teamId !== teamFilter.id
          ? `Current owner: ${mapping.teamName}. Listed because results were recorded for ${teamFilter.name}.`
          : `${mapping.connected ? 'Owning team' : 'Last owning team'}: ${mapping.teamName}.`}{' '}
        Connection revision {mapping.revision}.
      </p>
      {teamFilter && (
        <p className="space-muted">
          {filter
            ? `Showing history recorded for ${teamFilter.name}.`
            : 'Showing history recorded for every team.'}{' '}
          <button
            type="button"
            className="text-action"
            aria-pressed={allHistory}
            onClick={() => {
              setSelected(null);
              setAllHistory((value) => !value);
            }}
          >
            {filter ? 'Show all teams for this repository' : `Show only ${teamFilter.name}`}
          </button>
        </p>
      )}
      {missing ? (
        <p role="alert">{missingConnectionText}</p>
      ) : runs.checking || results.checking ? (
        <p role="status">Checking access…</p>
      ) : failure ? (
        <div>
          <p role="alert">{readFailure(failure, missingConnectionText)}</p>
          <button
            type="button"
            className="control mt-3"
            onClick={() => {
              for (const read of reads) if (read.isError) void read.refetch();
            }}
          >
            Retry repository history
          </button>
        </div>
      ) : !runs.data || !results.data ? (
        <p role="status">Loading repository history…</p>
      ) : (
        <>
          <LatestStatus run={runs.data.runs[0]} result={newest} filtered={filter !== undefined} />
          {shown && (
            <section aria-labelledby={`${id}-result`}>
              <h4 id={`${id}-result`} className="space-panel-title">
                {shown.id === newest?.id ? 'Latest saved result' : 'Selected saved result'}
              </h4>
              <ResultCards
                result={shown}
                currentTeamIds={currentTeamIds}
                onTeamSelect={onTeamSelect}
              />
            </section>
          )}
          {results.data.results.length > 0 && (
            <OperationalTrendChart
              results={results.data.results}
              hasOlder={results.data.nextCursor !== null}
            />
          )}
          <ResultHistory
            mappingId={mapping.id}
            teamId={filter}
            selectedId={shown?.id}
            onSelect={setSelected}
          />
          <RunHistory mappingId={mapping.id} teamId={filter} />
        </>
      )}
      {scope.owner && (
        <OwnerActions
          mapping={mapping}
          teams={teams}
          enabled={enabled}
          now={now}
          still={still}
          onChanged={(next) => {
            if (alive.current) setLocal(next);
          }}
        />
      )}
    </section>
  );
}
