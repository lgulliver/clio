import { IdentityError, name, object } from '../identity/input.ts';

export function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new IdentityError(400, 'invalid_request');
  return value;
}
export function settings(value: unknown) {
  const body = object(value, [
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
  return {
    expectedRevision,
    primaryProvider: body.primaryProvider,
    productionEnvironment: name(body.productionEnvironment),
    exposureAttested: body.exposureAttested,
  };
}
export interface DeploymentMapping {
  workspaceId: string;
  serviceId: string;
  mode: 'mock';
  revision: number;
  primaryProvider: 'github' | 'argocd';
  productionEnvironment: string;
  exposureAttested: boolean;
  observedAt: string;
}
