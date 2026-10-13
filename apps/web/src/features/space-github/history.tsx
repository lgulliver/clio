import { useState } from 'react';
import { formatReferencePeriod, formatTimestamp } from '../space/period';
import { readFailure, useCursorRecovery, useSpaceRead, useSpaceScope } from '../space/space-scope';
import {
  type OperationResult,
  type OperationRun,
  type OperationScope,
  parseOperationResultPage,
  parseOperationRunPage,
} from './api';
import { runReasonLabels, signalValue } from './result-cards';

/** Read path under the scoped SPACE API; the team filter and cursor are context-bound server-side. */
export function githubPath(spacePath: string, suffix: string, params: OperationScope) {
  const query = new URLSearchParams();
  if (params.teamId !== undefined) query.set('teamId', params.teamId);
  if (params.cursor !== undefined) query.set('cursor', params.cursor);
  return `${spacePath}/github${suffix}${query.size ? `?${query}` : ''}`;
}

function scopeFor(workspaceId: string, mappingId: string, teamId?: string, cursor?: string) {
  return {
    workspaceId,
    mappingId,
    ...(teamId !== undefined ? { teamId } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

/** One bounded (≤25) page of runs; the newest page is shared with the latest-status summary. */
export function useRunPage(mappingId: string, teamId?: string, cursor?: string) {
  const scope = useSpaceScope();
  const target = scopeFor(scope.workspace.id, mappingId, teamId, cursor);
  return useSpaceRead(
    `github/runs/${mappingId}/${teamId ?? ''}/${cursor ?? ''}`,
    githubPath(scope.path, `/mappings/${mappingId}/runs`, target),
    (value) => parseOperationRunPage(value, target),
  );
}

/** One bounded (≤25) page of immutable saved results. */
export function useResultPage(mappingId: string, teamId?: string, cursor?: string) {
  const scope = useSpaceScope();
  const target = scopeFor(scope.workspace.id, mappingId, teamId, cursor);
  return useSpaceRead(
    `github/results/${mappingId}/${teamId ?? ''}/${cursor ?? ''}`,
    githubPath(scope.path, `/mappings/${mappingId}/results`, target),
    (value) => parseOperationResultPage(value, target),
  );
}

const stateLabels: Readonly<Record<OperationRun['state'], string>> = {
  queued: 'Queued',
  running: 'Running',
  succeeded: 'Saved',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function runText(run: OperationRun) {
  return run.reason === null
    ? stateLabels[run.state]
    : `${stateLabels[run.state]}: ${runReasonLabels[run.reason]}`;
}

/**
 * Pending, failed and saved states are independent: the newest run never hides the newest saved
 * result, and no result means "not collected", not zero activity.
 */
export function LatestStatus({
  run,
  result,
  filtered,
}: {
  run: OperationRun | undefined;
  result: OperationResult | undefined;
  filtered: boolean;
}) {
  if (!run && !result)
    return (
      <p className="space-note">
        Not collected yet. No saved results for this repository
        {filtered ? ' recorded for this team' : ''}. Owners collect a window explicitly; refreshing
        never starts collection.
      </p>
    );
  return (
    <div className="space-github-status">
      {run && (run.state === 'queued' || run.state === 'running') && (
        <p className="space-note">
          Collection {run.state === 'queued' ? 'queued' : 'running'} for{' '}
          {formatReferencePeriod(run.windowStart, run.windowEnd)}. Use Refresh saved results to
          check progress.
        </p>
      )}
      {run && (run.state === 'failed' || run.state === 'cancelled') && (
        <p className="space-warning">
          Latest collection {run.state === 'failed' ? 'failed' : 'was cancelled'}:{' '}
          {run.reason ? runReasonLabels[run.reason] : 'no reason recorded'} (
          {formatReferencePeriod(run.windowStart, run.windowEnd)}).{' '}
          {result ? 'Earlier saved results remain available.' : 'No saved result yet.'}
        </p>
      )}
      {!result && run?.state === 'succeeded' && (
        <p className="space-note">The latest saved result is on the results list.</p>
      )}
    </div>
  );
}

function Pager({
  label,
  cursor,
  nextCursor,
  fetching,
  onNewest,
  onOlder,
}: {
  label: string;
  cursor: string | undefined;
  nextCursor: string | null | undefined;
  fetching: boolean;
  onNewest: () => void;
  onOlder: (cursor: string) => void;
}) {
  return (
    <div className="space-pager">
      <button
        type="button"
        className="space-secondary"
        aria-disabled={cursor === undefined}
        onClick={() => {
          if (cursor !== undefined) onNewest();
        }}
      >
        Newest {label}
      </button>
      <button
        type="button"
        className="space-secondary"
        aria-disabled={!nextCursor || fetching}
        onClick={() => {
          if (nextCursor && !fetching) onOlder(nextCursor);
        }}
      >
        Older {label}
      </button>
    </div>
  );
}

export function ResultHistory({
  mappingId,
  teamId,
  selectedId,
  onSelect,
}: {
  mappingId: string;
  teamId?: string | undefined;
  selectedId: string | undefined;
  onSelect: (result: OperationResult) => void;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [notice, setNotice] = useState('');
  const read = useResultPage(mappingId, teamId, cursor);
  useCursorRecovery(read.missing, cursor, () => {
    setCursor(undefined);
    setNotice('That page of saved results is no longer available. Showing the newest results.');
  });
  return (
    <section aria-label="Saved results">
      <h4 className="space-panel-title">Saved results</h4>
      {read.isPending || read.checking || (read.missing && cursor !== undefined) ? (
        <p role="status">Loading saved results…</p>
      ) : read.isError ? (
        <p role="alert">
          {readFailure(read, 'Saved results for this repository are no longer available.')}
        </p>
      ) : read.data.results.length === 0 ? (
        <p>{cursor ? 'No saved results on this older page.' : 'No saved results.'}</p>
      ) : (
        <div className="comparison-scroll">
          <table className="space-table">
            <caption>Up to 25 saved results per page, newest saved first</caption>
            <thead>
              <tr>
                <th scope="col">Window</th>
                <th scope="col">Team recorded</th>
                <th scope="col">PR review time (open to merge)</th>
                <th scope="col">Saved</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {read.data.results.map((item) => {
                const merge = item.calculated.signals.find((s) => s.id === 'open_to_merge');
                const period = formatReferencePeriod(item.windowStart, item.windowEnd);
                return (
                  <tr key={item.id}>
                    <th scope="row">{period}</th>
                    <td>{item.teamName}</td>
                    <td>{merge ? signalValue(merge) : 'Not available'}</td>
                    <td>{formatTimestamp(item.completedAt)}</td>
                    <td>
                      <button
                        type="button"
                        className="text-action"
                        aria-pressed={selectedId === item.id}
                        aria-label={`Show saved result for ${period}`}
                        onClick={() => onSelect(item)}
                      >
                        Show
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        label="results"
        cursor={cursor}
        nextCursor={read.data?.nextCursor}
        fetching={read.isFetching}
        onNewest={() => {
          setNotice('');
          setCursor(undefined);
        }}
        onOlder={(next) => {
          setNotice('');
          setCursor(next);
        }}
      />
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}

export function RunHistory({
  mappingId,
  teamId,
}: {
  mappingId: string;
  teamId?: string | undefined;
}) {
  const [cursor, setCursor] = useState<string | undefined>();
  const [notice, setNotice] = useState('');
  const read = useRunPage(mappingId, teamId, cursor);
  useCursorRecovery(read.missing, cursor, () => {
    setCursor(undefined);
    setNotice('That page of collection runs is no longer available. Showing the newest runs.');
  });
  return (
    <details className="space-history">
      <summary>Collection runs</summary>
      {read.isPending || read.checking || (read.missing && cursor !== undefined) ? (
        <p role="status">Loading collection runs…</p>
      ) : read.isError ? (
        <p role="alert">
          {readFailure(read, 'Collection runs for this repository are no longer available.')}
        </p>
      ) : read.data.runs.length === 0 ? (
        <p>{cursor ? 'No runs on this older page.' : 'No collection runs.'}</p>
      ) : (
        <div className="comparison-scroll">
          <table className="space-table">
            <caption>Up to 25 collection runs per page, newest queued first</caption>
            <thead>
              <tr>
                <th scope="col">Window</th>
                <th scope="col">State</th>
                <th scope="col">Team recorded</th>
                <th scope="col">Queued</th>
                <th scope="col">Finished</th>
              </tr>
            </thead>
            <tbody>
              {read.data.runs.map((item) => (
                <tr key={item.id}>
                  <th scope="row">{formatReferencePeriod(item.windowStart, item.windowEnd)}</th>
                  <td>{runText(item)}</td>
                  <td>{item.teamName}</td>
                  <td>{formatTimestamp(item.queuedAt)}</td>
                  <td>{item.completedAt ? formatTimestamp(item.completedAt) : 'Not finished'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Pager
        label="runs"
        cursor={cursor}
        nextCursor={read.data?.nextCursor}
        fetching={read.isFetching}
        onNewest={() => {
          setNotice('');
          setCursor(undefined);
        }}
        onOlder={(next) => {
          setNotice('');
          setCursor(next);
        }}
      />
      {notice && <p role="status">{notice}</p>}
    </details>
  );
}
