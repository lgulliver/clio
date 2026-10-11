import { IdentityError, name, object } from '../identity/input.ts';

export function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new IdentityError(400, 'invalid_request');
  return value;
}
export type MockScenario = 'partial' | 'complete-lifecycle';
export function scenario(value: unknown): MockScenario {
  if (value === undefined) return 'partial';
  if (value !== 'partial' && value !== 'complete-lifecycle')
    throw new IdentityError(400, 'invalid_request');
  return value;
}
export function fixtureProfile(selected: MockScenario, environment: string, exposure: boolean) {
  if (selected === 'complete-lifecycle' && (environment !== 'production' || !exposure))
    throw new IdentityError(400, 'invalid_request');
}
export function settings(value: unknown) {
  const body = object(value, [
    'scenario',
    'expectedRevision',
    'primaryProvider',
    'productionEnvironment',
    'exposureAttested',
  ]);
  if (body.expectedRevision === undefined) throw new IdentityError(409, 'conflict');
  const expectedRevision = body.expectedRevision === null ? null : revision(body.expectedRevision);
  if (
    (body.primaryProvider !== 'github' && body.primaryProvider !== 'argocd') ||
    typeof body.exposureAttested !== 'boolean'
  )
    throw new IdentityError(400, 'invalid_request');
  const selected = scenario(body.scenario);
  const environment = name(body.productionEnvironment);
  fixtureProfile(selected, environment, body.exposureAttested);
  return {
    scenario: selected,
    expectedRevision,
    primaryProvider: body.primaryProvider,
    productionEnvironment: environment,
    exposureAttested: body.exposureAttested,
  };
}
export interface DeploymentMapping {
  workspaceId: string;
  serviceId: string;
  mode: 'mock';
  scenario?: MockScenario;
  revision: number;
  primaryProvider: 'github' | 'argocd';
  productionEnvironment: string;
  exposureAttested: boolean;
  observedAt: string;
}
