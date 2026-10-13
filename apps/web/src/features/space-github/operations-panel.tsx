import { useId, useRef, useState } from 'react';
import type { Workspace } from '../identity/api';
import type { Team } from '../organization/api';
import { readFailure, useCursorRecovery, useSpaceRead, useSpaceScope } from '../space/space-scope';
import {
  type OperationMapping,
  parseOperationAvailability,
  parseOperationMappingPage,
} from './api';
import { CollectIntentProvider } from './collect-intents';
import { githubPath } from './history';
import { MappingDetail } from './mapping-detail';
import type { HistoricalTeam } from './result-cards';
import { OperationsSetupWizard } from './setup-wizard';

type Clock = () => Date;

/**
 * GitHub pull request activity beside team pulses. Lives inside the role-scoped SPACE provider,
 * so reads share its identity/workspace/role keys, query aborts and access revalidation, and owner
 * state is discarded whenever the role-scoped tree remounts. Refresh only re-reads saved data.
 */
export function OperationsPanel({
  workspaceId,
  role,
  teamId,
  teamName,
  teams,
  now,
  onTeamSelect,
}: {
  workspaceId: string;
  role: Workspace['role'];
  teamId?: string | undefined;
  teamName?: string | undefined;
  teams: readonly Team[];
  now: Clock;
  onTeamSelect?: ((team: HistoricalTeam) => void) | undefined;
}) {
  const scope = useSpaceScope();
  const id = useId();
  const [wizard, setWizard] = useState<number | null>(null);
  // `focus` moves keyboard focus to a detail opened by the user, not to a remounted one.
  const [opened, setOpened] = useState<{ mapping: OperationMapping; focus: boolean } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const availability = useSpaceRead(
    'github/availability',
    `${scope.path}/github/availability`,
    (value) => parseOperationAvailability(value, { workspaceId, role }),
  );
  // Fence: never render this scope's data under a different workspace or role.
  if (scope.workspace.id !== workspaceId || scope.workspace.role !== role) return null;
  const data = availability.data;
  const enabled = data?.enabled === true;
  const grants = data && 'grants' in data ? data.grants : [];
  const team = teamId ? { id: teamId, name: teamName ?? 'Selected team' } : undefined;
  return (
    <CollectIntentProvider>
      <section className="panel space-github" aria-labelledby={`${id}-title`}>
        <div className="space-section-heading">
          <h2 id={`${id}-title`} className="space-panel-title">
            GitHub pull request activity
          </h2>
          <button type="button" className="space-secondary" onClick={() => scope.refresh()}>
            Refresh saved results
          </button>
        </div>
        <p className="space-muted">
          Provisional activity, collaboration and flow observations from connected repositories,
          separate from team pulse results. Each repository is shown on its own: no team or
          workspace totals, no individual metrics and no scores.
        </p>
        {availability.checking ? (
          <p role="status">Checking access…</p>
        ) : availability.isError ? (
          <div>
            <p role="alert">
              {readFailure(availability, 'GitHub activity settings are unavailable right now.')}
            </p>
            <button
              type="button"
              className="control mt-3"
              onClick={() => void availability.refetch()}
            >
              Retry GitHub activity
            </button>
          </div>
        ) : !data ? (
          <p role="status">Loading GitHub activity…</p>
        ) : (
          <>
            {!enabled && (
              <p className="space-note">
                GitHub activity collection is not set up for this workspace. Saved history stays
                readable below.
              </p>
            )}
            {scope.owner && enabled && wizard === null && (
              <button
                ref={trigger}
                type="button"
                className="control"
                onClick={() => setWizard((current) => (current ?? 0) + 1)}
              >
                Connect a repository
              </button>
            )}
            {scope.owner && enabled && wizard !== null && (
              <OperationsSetupWizard
                key={wizard}
                grants={grants}
                teams={teams}
                now={now}
                onClose={() => {
                  setWizard(null);
                  requestAnimationFrame(() => trigger.current?.focus());
                }}
                onOpen={(mapping) => {
                  setWizard(null);
                  setOpened({ mapping, focus: true });
                }}
              />
            )}
          </>
        )}
        {data && (
          <MappingBrowser
            key={teamId ?? ''}
            team={team}
            teams={teams}
            enabled={enabled}
            now={now}
            opened={opened}
            onOpen={(mapping) => setOpened(mapping ? { mapping, focus: true } : null)}
            onFocused={() =>
              setOpened((current) => (current ? { ...current, focus: false } : current))
            }
            onTeamSelect={onTeamSelect}
          />
        )}
      </section>
    </CollectIntentProvider>
  );
}

function MappingBrowser({
  team,
  teams,
  enabled,
  now,
  opened,
  onOpen,
  onFocused,
  onTeamSelect,
}: {
  team: { id: string; name: string } | undefined;
  teams: readonly Team[];
  enabled: boolean;
  now: Clock;
  opened: { mapping: OperationMapping; focus: boolean } | null;
  onOpen: (mapping: OperationMapping | null) => void;
  onFocused: () => void;
  onTeamSelect?: ((team: HistoricalTeam) => void) | undefined;
}) {
  const scope = useSpaceScope();
  const [cursor, setCursor] = useState<string | undefined>();
  const [notice, setNotice] = useState('');
  const target = {
    workspaceId: scope.workspace.id,
    ...(team ? { teamId: team.id } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  };
  const read = useSpaceRead(
    `github/mappings/${team?.id ?? ''}/${cursor ?? ''}`,
    githubPath(scope.path, '/mappings', target),
    (value) => parseOperationMappingPage(value, target),
  );
  useCursorRecovery(read.missing, cursor, () => {
    setCursor(undefined);
    setNotice('That page of repositories is no longer available. Showing the newest repositories.');
  });
  const rows = [...(read.data?.mappings ?? [])].sort(
    (a, b) =>
      a.teamName.localeCompare(b.teamName) || a.repositoryLabel.localeCompare(b.repositoryLabel),
  );
  return (
    <div className="space-github-mappings">
      <h3 className="space-panel-title">
        {team ? `Repositories for ${team.name}` : 'Repositories by owning team'}
      </h3>
      {read.isPending || read.checking || (read.missing && cursor !== undefined) ? (
        <p role="status">Loading repositories…</p>
      ) : read.isError ? (
        <div>
          <p role="alert">{readFailure(read, 'Repositories are unavailable right now.')}</p>
          <button type="button" className="control mt-3" onClick={() => void read.refetch()}>
            Retry repositories
          </button>
        </div>
      ) : rows.length === 0 ? (
        <p>
          {cursor
            ? 'No repositories on this older page.'
            : team
              ? 'No repositories connected to or recorded for this team.'
              : 'No repositories connected yet.'}
        </p>
      ) : (
        <div className="comparison-scroll">
          <table className="space-table">
            <caption>
              Up to 25 repository connections per page.{' '}
              {team
                ? 'Includes repositories this team owns now or owned when results were saved.'
                : 'Grouped by current or last owning team; saved results keep the team recorded when collected.'}
            </caption>
            <thead>
              <tr>
                <th scope="col">Repository</th>
                <th scope="col">Owning team</th>
                <th scope="col">Status</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  <th scope="row">{item.repositoryLabel}</th>
                  <td>
                    {item.teamName}
                    {team && item.teamId !== team.id
                      ? ' (current owner; history recorded here)'
                      : ''}
                  </td>
                  <td>{item.connected ? 'Connected' : 'Not connected'}</td>
                  <td>
                    <button
                      type="button"
                      className="text-action"
                      aria-pressed={opened?.mapping.id === item.id}
                      aria-label={`View results for ${item.repositoryLabel}`}
                      onClick={() => onOpen(item)}
                    >
                      View
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
            setNotice('');
            setCursor(undefined);
          }}
        >
          Newest repositories
        </button>
        <button
          type="button"
          className="space-secondary"
          aria-disabled={!read.data?.nextCursor || read.isFetching}
          onClick={() => {
            const next = read.data?.nextCursor;
            if (!next || read.isFetching) return;
            setNotice('');
            setCursor(next);
          }}
        >
          Older repositories
        </button>
      </div>
      {notice && <p role="status">{notice}</p>}
      {opened && (
        <MappingDetail
          key={opened.mapping.id}
          mapping={rows.find((item) => item.id === opened.mapping.id) ?? opened.mapping}
          focus={opened.focus}
          onFocused={onFocused}
          teamFilter={team}
          teams={teams}
          enabled={enabled}
          now={now}
          onTeamSelect={onTeamSelect}
          onClose={() => onOpen(null)}
        />
      )}
    </div>
  );
}
