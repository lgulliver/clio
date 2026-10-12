import { describe, expect, it } from 'vitest';
import { defaultView, resolveOrganizationView } from '../organization/view-state';
import { parseOverviewSearch, searchForView, viewFromSearch } from './view-search';

const workspace = '11111111-1111-4111-8111-111111111111';
const team = '22222222-2222-4222-8222-222222222222';
const product = '33333333-3333-4333-8333-333333333333';
const service = '44444444-4444-4444-8444-444444444444';
const otherTeam = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const org = {
  workspaceId: workspace,
  teams: [
    { id: team, workspaceId: workspace, name: 'Platform' },
    { id: otherTeam, workspaceId: workspace, name: 'Commerce' },
  ],
  products: [{ id: product, workspaceId: workspace, name: 'Payments', teamId: otherTeam }],
  services: [{ id: service, workspaceId: workspace, name: 'API' }],
  assignments: [{ serviceId: service, productId: product }],
};

describe('view URL boundary', () => {
  it('round trips exact windows, source and IDs while discarding unknown fields', () => {
    const search = parseOverviewSearch({
      workspace,
      team,
      product,
      service,
      source: 'argo',
      window: '2024-02-29_2024-03-01',
      previous: '2024-02-28_2024-02-29',
      token: 'private-value',
    });
    const view = viewFromSearch(search);
    expect(view.period).toBe('2024-02-29T00:00:00.000Z|2024-03-01T00:00:00.000Z');
    expect(searchForView(workspace, view)).toEqual(search);
    expect(search).not.toHaveProperty('token');
    expect(searchForView(workspace, defaultView)).toEqual({ workspace });
  });
  it.each([
    '2025-02-29_2025-03-01',
    '2024-02-30_2024-03-02',
    '2026-01-01_2026-01-01',
    '2026-01-03_2026-01-02',
    'garbage',
  ])('rejects impossible or unordered dates: %s', (window) => {
    const search = parseOverviewSearch({ workspace, window, previous: '2026-01-01_2026-01-03' });
    expect(search).toEqual({ workspace, invalidView: true });
    expect(viewFromSearch(search).period).toBe('latest');
  });
  it('rejects duplicate-valued, malformed and unsupported fields without echoing them', () => {
    expect(
      parseOverviewSearch({
        workspace: [workspace, team],
        service,
        source: 'external',
        team: 'malformed',
        window: ['2026-01-01_2026-01-03'],
      }),
    ).toEqual({ invalidView: true });
    expect(
      parseOverviewSearch({
        workspace: workspace.toUpperCase(),
        product: 'unassigned',
        source: 'measurement',
      }),
    ).toEqual({ workspace, product: 'unassigned', source: 'measurement' });
  });
  it('resolves current ownership and safe missing-target fallback within authorized organization', () => {
    const selected = { ...defaultView, teamId: team, productId: product, serviceId: service };
    expect(resolveOrganizationView(selected, org).view.teamId).toBe(otherTeam);
    expect(resolveOrganizationView({ ...selected, serviceId: otherTeam }, org)).toMatchObject({
      unavailable: true,
      view: { serviceId: '', productId: product, teamId: otherTeam },
    });
    const detached = { ...org, assignments: [{ serviceId: service, productId: null }] };
    expect(resolveOrganizationView(selected, detached).view).toMatchObject({
      serviceId: service,
      productId: 'unassigned',
      teamId: '',
    });
    expect(
      resolveOrganizationView({ ...defaultView, productId: service, teamId: team }, org),
    ).toMatchObject({ unavailable: true, view: { productId: '', teamId: team } });
  });
});
