import type { Organization } from './api';
import type { ComparisonSource } from './comparison-data';

export type OrganizationView = {
  teamId: string;
  productId: string;
  serviceId: string;
  source: ComparisonSource;
  period: string;
  previousPeriod: string;
};
export const defaultView: OrganizationView = {
  teamId: '',
  productId: '',
  serviceId: '',
  source: 'measurement',
  period: 'latest',
  previousPeriod: '',
};
export function resolveOrganizationView(view: OrganizationView, organization: Organization) {
  const service = organization.services.find((item) => item.id === view.serviceId);
  const assigned = service
    ? organization.assignments.find((item) => item.serviceId === service.id)?.productId
    : view.productId;
  const product = organization.products.find((item) => item.id === assigned);
  const unassigned = service ? assigned === null : view.productId === 'unassigned';
  const team = organization.teams.find(
    (item) => item.id === (service ? product?.teamId : (product?.teamId ?? view.teamId)),
  );
  const resolved: OrganizationView = {
    ...view,
    teamId: unassigned ? '' : (team?.id ?? ''),
    productId: product?.id ?? (unassigned ? 'unassigned' : ''),
    serviceId: service?.id ?? '',
  };
  const unavailable = Boolean(
    (view.serviceId && !service) ||
      (view.productId &&
        view.productId !== 'unassigned' &&
        !organization.products.some((item) => item.id === view.productId)) ||
      (view.teamId && !organization.teams.some((item) => item.id === view.teamId)),
  );
  return { view: resolved, unavailable };
}

export type ChangeOrganizationView = (
  update: (current: OrganizationView) => OrganizationView,
) => void;
