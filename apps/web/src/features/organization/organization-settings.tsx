import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError, errorMessage, request, type Service, type Workspace } from '../identity/api';
import { useSession } from '../identity/session';
import { useStoredRead } from '../result-history/history-browser';
import { parseAssignment, parseOrganization, parseProduct, parseTeam } from './api';

function OrganizationEditor({
  workspace,
  services,
  validSelection,
  onAccessLost,
}: {
  workspace: Workspace;
  services: Service[];
  validSelection: () => boolean;
  onAccessLost: () => void;
}) {
  const session = useSession();
  const client = useQueryClient();
  const revision = session.revision;
  const mounted = useRef(true);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [teamName, setTeamName] = useState('');
  const [productName, setProductName] = useState('');
  const [teamId, setTeamId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [productId, setProductId] = useState('');
  const id = useId();
  const path = `/api/workspaces/${workspace.id}`;
  const query = useStoredRead(
    `${workspace.id}/organization/${services.map((s) => s.id).join('.')}`,
    `${path}/organization`,
    (value) => parseOrganization(value, workspace.id),
  );
  const denied = query.error instanceof ApiError && [401, 403, 404].includes(query.error.status);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (denied) onAccessLost();
  }, [denied, onAccessLost]);
  const valid = () => mounted.current && session.current(revision) && validSelection();
  async function save<T>(
    event: FormEvent,
    endpoint: string,
    body: object,
    parse: (value: unknown) => T,
    message: string,
    clear: () => void,
  ) {
    event.preventDefault();
    if (pending.current || !valid()) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(`${path}${endpoint}`, parse, { body });
      if (!valid()) return;
      clear();
      setNotice(message);
      await query.refetch();
      if (valid())
        void client.invalidateQueries({
          predicate: (entry) =>
            entry.queryKey[0] === 'identity' &&
            entry.queryKey[1] === session.user?.id &&
            entry.queryKey[2] === revision &&
            entry.queryKey.some(
              (part) =>
                typeof part === 'string' && part.startsWith(`${workspace.id}/organization/`),
            ),
        });
    } catch (failure) {
      if (!valid()) return;
      if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
        if (failure.status === 401) session.expire(revision);
        onAccessLost();
      }
      setError(errorMessage(failure));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <section className="organization-settings mt-6" aria-label="Teams and products">
      <h3 className="font-semibold">Teams and products</h3>
      <p className="mt-2 text-sm text-clio-muted">
        Teams own products. Products group services. Unassigned services remain visible in
        Engineering.
      </p>
      {query.isPending ? (
        <p role="status">Loading organization…</p>
      ) : query.isError ? (
        <div>
          <p role="alert">{errorMessage(query.error)}</p>
          {!denied && (
            <button className="control mt-3" type="button" onClick={() => void query.refetch()}>
              Retry organization
            </button>
          )}
        </div>
      ) : (
        <>
          <p className="mt-3">
            {query.data.teams.length} teams · {query.data.products.length} products ·{' '}
            {query.data.assignments.filter((a) => a.productId === null).length} unassigned services
          </p>
          {workspace.role === 'owner' && (
            <div className="organization-forms">
              <form
                onSubmit={(e) =>
                  void save(
                    e,
                    '/teams',
                    { name: teamName.trim() },
                    (v) => parseTeam(v, workspace.id),
                    'Team created.',
                    () => setTeamName(''),
                  )
                }
              >
                <label htmlFor={`${id}-team-name`}>New team name</label>
                <input
                  id={`${id}-team-name`}
                  className="field"
                  required
                  value={teamName}
                  readOnly={busy}
                  onChange={(e) => setTeamName(e.target.value)}
                />
                <button className="control mt-3" type="submit" aria-disabled={busy}>
                  Create team
                </button>
              </form>
              <form
                onSubmit={(e) =>
                  void save(
                    e,
                    '/products',
                    { name: productName.trim(), teamId },
                    (v) => parseProduct(v, workspace.id),
                    'Product created.',
                    () => setProductName(''),
                  )
                }
              >
                <label htmlFor={`${id}-product-name`}>New product name</label>
                <input
                  id={`${id}-product-name`}
                  className="field"
                  required
                  value={productName}
                  readOnly={busy}
                  onChange={(e) => setProductName(e.target.value)}
                />
                <label htmlFor={`${id}-team`}>Owning team</label>
                <select
                  id={`${id}-team`}
                  className="field"
                  required
                  value={teamId}
                  disabled={busy}
                  onChange={(e) => setTeamId(e.target.value)}
                >
                  <option value="">Choose a team</option>
                  {query.data.teams.map((team) => (
                    <option key={team.id} value={team.id}>
                      {team.name}
                    </option>
                  ))}
                </select>
                <button className="control mt-3" type="submit" aria-disabled={busy}>
                  Create product
                </button>
              </form>
              <form
                onSubmit={(e) =>
                  void save(
                    e,
                    `/services/${serviceId}/product`,
                    { productId: productId || null },
                    (v) => parseAssignment(v, serviceId),
                    'Service assignment saved.',
                    () => {},
                  )
                }
              >
                <label htmlFor={`${id}-service`}>Service to assign</label>
                <select
                  id={`${id}-service`}
                  className="field"
                  required
                  value={serviceId}
                  disabled={busy}
                  onChange={(e) => {
                    setServiceId(e.target.value);
                    setProductId(
                      query.data.assignments.find((a) => a.serviceId === e.target.value)
                        ?.productId ?? '',
                    );
                  }}
                >
                  <option value="">Choose a service</option>
                  {query.data.services.map((service) => (
                    <option key={service.id} value={service.id}>
                      {service.name}
                    </option>
                  ))}
                </select>
                <label htmlFor={`${id}-product`}>Assigned product</label>
                <select
                  id={`${id}-product`}
                  className="field"
                  value={productId}
                  disabled={busy}
                  onChange={(e) => setProductId(e.target.value)}
                >
                  <option value="">Unassigned</option>
                  {query.data.products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {query.data.teams.find((t) => t.id === product.teamId)?.name} / {product.name}
                    </option>
                  ))}
                </select>
                <button className="control mt-3" type="submit" aria-disabled={busy}>
                  Save service assignment
                </button>
              </form>
            </div>
          )}
        </>
      )}
      {busy && <p role="status">Saving organization…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

export function OrganizationSettings(props: Parameters<typeof OrganizationEditor>[0]) {
  const [open, setOpen] = useState(false);
  return (
    <details className="mt-6" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="text-action cursor-pointer">Organize teams and products</summary>
      {open && <OrganizationEditor {...props} />}
    </details>
  );
}
