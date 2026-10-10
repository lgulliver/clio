import { describe, expect, it } from 'vitest';
import { settings } from '../src/features/deployment-mappings/input.ts';
import { fictionalEvidence, previewMapping } from '../src/features/deployment-mappings/preview.ts';

const base = {
  workspaceId: '00000000-0000-0000-0000-000000000001',
  serviceId: '00000000-0000-0000-0000-000000000002',
  mode: 'mock',
  revision: 2,
  primaryProvider: 'github',
  productionEnvironment: 'production',
  exposureAttested: true,
  observedAt: '2026-10-10T00:00:00.000Z',
} as const;
const service = { id: base.serviceId, name: 'Actual scoped service' };
describe('mock mapping boundary', () => {
  it('rejects unknown, incomplete and malformed settings and counts Unicode points', () => {
    const input = {
      expectedRevision: null,
      primaryProvider: 'github',
      productionEnvironment: ' \uFEFFproduction\t ',
      exposureAttested: false,
    };
    expect(settings(input).productionEnvironment).toBe('production');
    expect(
      settings({ ...input, productionEnvironment: '😀'.repeat(200) }).productionEnvironment,
    ).toHaveLength(400);
    for (const change of [
      { token: 'private' },
      { mode: 'live' },
      { expectedRevision: 0 },
      { expectedRevision: 1.5 },
      { expectedRevision: '1' },
      { expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
      { primaryProvider: 'other' },
      { exposureAttested: 'true' },
      { productionEnvironment: '😀'.repeat(201) },
      { productionEnvironment: '\n' },
      { productionEnvironment: 'bad\0' },
    ])
      expect(() => settings({ ...input, ...change })).toThrow();
    expect(() =>
      settings({
        primaryProvider: 'github',
        productionEnvironment: 'production',
        exposureAttested: true,
      }),
    ).toThrow('conflict');
  });
  for (const provider of ['github', 'argocd'] as const) {
    it(`calculates ${provider} fictional qualification with incomplete coverage and null unavailable metrics`, () => {
      const mapping = { ...base, primaryProvider: provider };
      const preview = previewMapping(mapping, service);
      expect(preview).toMatchObject({
        mode: 'mock',
        mappingRevision: 2,
        qualification: 'qualifying',
        rolloutCount: 1,
        evidenceCutoff: base.observedAt,
        coverage: {
          collectionComplete: false,
          deploymentHistoryComplete: false,
          recoveryEvidenceComplete: false,
        },
        deploymentFrequency: {
          count: 1,
          status: 'provisional',
          deploymentsPerDay: null,
          qualityReasons: ['incomplete_collection'],
        },
        changeFailureRate: null,
        failedDeploymentRecoveryTime: null,
      });
      for (const change of [
        { exposureAttested: false },
        { productionEnvironment: 'another-environment' },
      ]) {
        expect(previewMapping({ ...mapping, ...change }, service)).toMatchObject({
          qualification: 'unknown',
          rolloutCount: 1,
          deploymentFrequency: { count: 0, status: 'provisional', deploymentsPerDay: null },
        });
      }
      expect(
        previewMapping(mapping, service, {
          ...fictionalEvidence(provider),
          statuses: fictionalEvidence(provider).statuses.map((row) => ({
            ...row,
            observedAt: '2026-10-10T00:00:00.000001Z',
          })),
        }).evidenceCutoff,
      ).toBe('2026-10-10T00:00:00.001Z');
      const batch = fictionalEvidence(provider);
      expect(batch.deployments[0]?.repository).toBeNull();
      expect(batch.deployments[0]?.reconciledConfigurationRevision).toBe(
        provider === 'argocd' ? 'mock-config-revision' : null,
      );
      expect(() => previewMapping(mapping, { ...service, id: 'wrong-service' })).toThrow();
      expect(() =>
        previewMapping(mapping, service, {
          ...batch,
          deployments: batch.deployments.map((row) => ({
            ...row,
            sourceDeploymentId: 'unbound-operation',
          })),
        }),
      ).toThrow();
      expect(
        previewMapping(mapping, service, {
          ...batch,
          statuses: batch.statuses.map((row) => ({
            ...row,
            observedAt: '2026-10-11T00:00:00.000Z',
          })),
        }).evidenceCutoff,
      ).toBe('2026-10-11T00:00:00.000Z');
    });
  }
});
