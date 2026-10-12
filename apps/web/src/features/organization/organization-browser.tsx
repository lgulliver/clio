import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, type Service } from '../identity/api';
import { useStoredRead } from '../result-history/history-browser';
import { parseOrganization } from './api';
import { type ComparisonSource, ServiceComparison } from './service-comparison';

export function OrganizationBrowser({
  workspaceId,
  renderService,
}: {
  workspaceId: string;
  renderService: (service: Service) => ReactNode;
}) {
  const [blocked, setBlocked] = useState(false);
  const accessLost = useCallback(() => setBlocked(true), []);
  const [source, setSource] = useState<ComparisonSource>('measurement');
  const [period, setPeriod] = useState('latest');
  const [teamId, setTeamId] = useState('');
  const [productId, setProductId] = useState('');
  const [serviceId, setServiceId] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const query = useStoredRead(
    `${workspaceId}/organization/browser`,
    `/api/workspaces/${workspaceId}/organization`,
    (value) => parseOrganization(value, workspaceId),
  );
  useEffect(() => {
    if (focusRequest > 0) heading.current?.focus();
  }, [focusRequest]);
  if (blocked)
    return (
      <div className="panel" role="alert">
        Workspace results are no longer accessible. Select another workspace or refresh your access
        in Workspace.
      </div>
    );
  if (query.isPending) return <p role="status">Loading organization…</p>;
  if (query.isError)
    return (
      <div className="panel">
        <p role="alert">{errorMessage(query.error)}</p>
        <button className="control mt-3" type="button" onClick={() => void query.refetch()}>
          Retry organization
        </button>
      </div>
    );
  const organization = query.data;
  const services = organization.services;
  const assignments = new Map(
    organization.assignments.map((item) => [item.serviceId, item.productId]),
  );
  const selectedService = services.find((item) => item.id === serviceId);
  const currentProductId = selectedService ? assignments.get(selectedService.id) : productId;
  const product = organization.products.find((item) => item.id === currentProductId);
  const team = organization.teams.find(
    (item) => item.id === (selectedService ? product?.teamId : (product?.teamId ?? teamId)),
  );
  const products = organization.products.filter((item) => !team || item.teamId === team.id);
  const unassigned = selectedService ? currentProductId === null : productId === 'unassigned';
  const scoped = services.filter((service) => {
    const assigned = assignments.get(service.id);
    return unassigned
      ? assigned === null
      : product
        ? assigned === product.id
        : team
          ? products.some((item) => item.id === assigned)
          : true;
  });
  const service = scoped.find((item) => item.id === serviceId);
  const title =
    service?.name ??
    product?.name ??
    (unassigned ? 'Unassigned services' : (team?.name ?? 'Engineering'));
  function ownership(id: string) {
    const owned = organization.products.find((item) => item.id === assignments.get(id));
    return owned
      ? `${organization.teams.find((item) => item.id === owned.teamId)?.name} / ${owned.name}`
      : 'Unassigned';
  }
  function selectService(id: string) {
    const owned = organization.products.find((item) => item.id === assignments.get(id));
    setTeamId(owned?.teamId ?? '');
    setProductId(owned?.id ?? 'unassigned');
    setServiceId(id);
  }
  return (
    <div className="organization-browser">
      <nav aria-label="Engineering drill-down" className="scope-breadcrumbs">
        <ol>
          <li>
            <button
              type="button"
              aria-current={!team && !product && !unassigned && !service ? 'page' : undefined}
              onClick={() => {
                setFocusRequest((request) => request + 1);
                setTeamId('');
                setProductId('');
                setServiceId('');
              }}
            >
              Engineering
            </button>
          </li>
          {team && (
            <li>
              <button
                type="button"
                aria-current={!product && !service ? 'page' : undefined}
                onClick={() => {
                  setFocusRequest((request) => request + 1);
                  setTeamId(team.id);
                  setProductId('');
                  setServiceId('');
                }}
              >
                {team.name}
              </button>
            </li>
          )}
          {(product || unassigned) && (
            <li>
              <button
                type="button"
                aria-current={!service ? 'page' : undefined}
                onClick={() => {
                  setFocusRequest((request) => request + 1);
                  setTeamId(team?.id ?? '');
                  setProductId(product?.id ?? (unassigned ? 'unassigned' : ''));
                  setServiceId('');
                }}
              >
                {product?.name ?? 'Unassigned services'}
              </button>
            </li>
          )}
          {service && <li aria-current="page">{service.name}</li>}
        </ol>
      </nav>
      <div className="scope-selectors">
        <label>
          Team
          <select
            className="field"
            value={team?.id ?? ''}
            onChange={(e) => {
              setTeamId(e.target.value);
              setProductId('');
              setServiceId('');
            }}
          >
            <option value="">All teams</option>
            {organization.teams.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Product
          <select
            className="field"
            value={product?.id ?? (unassigned ? 'unassigned' : '')}
            onChange={(e) => {
              setProductId(e.target.value);
              const selected = organization.products.find((item) => item.id === e.target.value);
              setTeamId(
                selected?.teamId ?? (e.target.value === 'unassigned' ? '' : (team?.id ?? '')),
              );
              setServiceId('');
            }}
          >
            <option value="">All products</option>
            {products.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
            {!team && <option value="unassigned">Unassigned services</option>}
          </select>
        </label>
        {services.length > 0 && (
          <label htmlFor="overview-service">
            Service
            <select
              id="overview-service"
              className="field"
              value={service?.id ?? ''}
              onChange={(e) => {
                if (e.target.value) selectService(e.target.value);
                else {
                  setTeamId(team?.id ?? '');
                  setProductId(product?.id ?? (unassigned ? 'unassigned' : ''));
                  setServiceId('');
                }
              }}
            >
              <option value="">Choose a service</option>
              {scoped.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <h2 ref={heading} tabIndex={-1} className="scope-title">
        {title}
      </h2>
      {!service && (
        <>
          {!services.length && <p>No services in this workspace. Add a service in Workspace.</p>}
          <p className="text-clio-muted">{scoped.length} services · current ownership</p>
          <div className="scope-groups">
            {!team &&
              !product &&
              !unassigned &&
              organization.teams.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setFocusRequest((request) => request + 1);
                    setTeamId(item.id);
                    setProductId('');
                    setServiceId('');
                  }}
                >
                  <strong>{item.name}</strong>{' '}
                  <span>
                    {organization.products.filter((p) => p.teamId === item.id).length} products
                  </span>
                </button>
              ))}
            {team &&
              !product &&
              products.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setFocusRequest((request) => request + 1);
                    setProductId(item.id);
                    setServiceId('');
                  }}
                >
                  <strong>{item.name}</strong>{' '}
                  <span>
                    {scoped.filter((s) => assignments.get(s.id) === item.id).length} services
                  </span>
                </button>
              ))}
          </div>
          {!organization.teams.length && (
            <p className="mt-3 text-clio-muted">
              Create teams and products in Workspace to organize Engineering. Services remain
              available below.
            </p>
          )}
          {services.length > 0 && (
            <ServiceComparison
              key={`${team?.id ?? ''}/${product?.id ?? productId}`}
              services={scoped}
              ownership={ownership}
              select={(id) => {
                setFocusRequest((request) => request + 1);
                selectService(id);
              }}
              source={source}
              onSourceChange={(value) => {
                setSource(value);
                setPeriod('latest');
              }}
              period={period}
              onPeriodChange={setPeriod}
              onAccessLost={accessLost}
            />
          )}
        </>
      )}
      {service && renderService(service)}
    </div>
  );
}
