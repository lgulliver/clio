import { type EvidenceBatch, identity } from '@clio/adapters';
import {
  type Dataset,
  type ValidatedSnapshot,
  validateSnapshot,
  validateStructure,
} from '@clio/oems';
import { object } from '../identity/input.ts';
import type { DeploymentMapping } from './input.ts';

// Exhaustive fictional universe, version 1. These are application source commits,
// never GitOps configuration revisions. Every change first deploys in this window.
const observedAt = '2026-01-03T00:00:00.000Z';
const windowEnd = '2026-01-03T00:00:00.000Z';
const roster = [
  {
    name: 'healthy',
    failure: 'no_recorded_failure',
    rework: 'not_incident_driven',
    effectiveAt: '2026-01-01T10:05:00.000Z',
    committedAt: '2026-01-01T08:05:00.000Z',
    commit: '1'.repeat(40),
  },
  {
    name: 'broken',
    failure: 'failed',
    rework: 'not_incident_driven',
    effectiveAt: '2026-01-02T10:05:00.000Z',
    committedAt: '2026-01-02T09:05:00.000Z',
    commit: '2'.repeat(40),
  },
  {
    name: 'recovery',
    failure: 'no_recorded_failure',
    rework: 'incident_driven',
    effectiveAt: '2026-01-02T10:35:00.000Z',
    committedAt: '2026-01-02T10:05:00.000Z',
    commit: '3'.repeat(40),
  },
] as const;
export function lifecycleEvidence(provider: DeploymentMapping['primaryProvider']): EvidenceBatch {
  const sourceId = identity(provider, 'mock-instance');
  return {
    deployments: roster.map((entry) => ({
      id: identity(sourceId, 'deployment', `fictional-${entry.name}`),
      sourceId,
      sourceDeploymentId: `fictional-${entry.name}`,
      revision: provider === 'github' ? entry.effectiveAt : `fictional-${entry.name}-v1`,
      environment: 'production',
      eventAt: entry.effectiveAt,
      observedAt,
      sourceRef: `urn:clio:mock:${provider}:lifecycle:${entry.name}`,
      repository: { repositoryId: `fictional-application-${entry.name}`, tipSha: entry.commit },
      reconciledConfigurationRevision:
        provider === 'argocd' ? `fictional-config-${entry.name}` : null,
      configurationRepositoryId: provider === 'argocd' ? 'fictional-config-repository' : null,
      deploymentTask: null,
      operationKind: 'rollout',
    })),
    statuses: roster.map((entry) => ({
      id: identity(sourceId, entry.name, 'exposure'),
      deploymentId: identity(sourceId, 'deployment', `fictional-${entry.name}`),
      revision: 'fictional-exposure-v1',
      environment: 'production',
      signal: provider === 'github' ? 'success' : 'Succeeded',
      health: provider === 'argocd' ? 'Healthy' : null,
      consumerExposure: true,
      eventAt: entry.effectiveAt,
      observedAt,
      sourceRef: `urn:clio:mock:exposure:${entry.name}`,
    })),
  };
}

/** Attach independent fictional facts to reconciled operations, then validate again.
 * Coverage is an explicit exhaustive fixture census, never inferred from provider health.
 */
export function completeLifecycle(
  snapshot: ValidatedSnapshot,
  provider: DeploymentMapping['primaryProvider'],
) {
  const copied = validateStructure('dataset', snapshot.data);
  if (!copied.ok) throw new Error('Invalid fictional basis');
  const basis: Dataset = copied.data;
  if (
    basis.deployments.length !== roster.length ||
    basis.window.start !== '2026-01-01T00:00:00.000Z' ||
    basis.window.end !== windowEnd ||
    basis.services.length !== 1
  )
    throw new Error('Fictional census mismatch');
  const deployments = roster.map((entry) => {
    const groupId = identity(
      'source',
      identity(provider, 'mock-instance'),
      `fictional-${entry.name}`,
    );
    const rows = basis.deployments.filter((d) => d.rollout_group_id === groupId);
    const row = rows[0];
    const service = basis.services[0];
    if (
      !row ||
      !service ||
      rows.length !== 1 ||
      row.qualification !== 'qualifying' ||
      row.service_id !== service.id ||
      row.id !== identity('deployment', service.id, groupId) ||
      row.effective_at !== entry.effectiveAt ||
      !row.source_refs.includes(`urn:clio:mock:${provider}:lifecycle:${entry.name}`)
    )
      throw new Error('Fictional operation mismatch');
    const tips = row.extensions?.tip_provenance;
    if (!Array.isArray(tips) || tips.length !== 1)
      throw new Error('Fictional application provenance mismatch');
    const tip = object(tips[0], ['source_id', 'repository_id', 'tip_sha']);
    if (
      tip.repository_id !== `fictional-application-${entry.name}` ||
      tip.tip_sha !== entry.commit ||
      tip.source_id !== identity(provider, 'mock-instance')
    )
      throw new Error('Fictional application provenance mismatch');
    return {
      ...row,
      change_ids: [`fictional-change-${entry.name}`],
      change_links_complete: true,
      failure: entry.failure,
      rework: entry.rework,
      failure_evidence_refs: [`urn:clio:mock:independent:failure:${entry.name}`],
      rework_evidence_refs: [`urn:clio:mock:independent:rework:${entry.name}`],
      source_refs: [
        ...row.source_refs,
        `urn:clio:mock:independent:application-history:${entry.name}`,
      ],
    };
  });
  const broken = deployments.find((d) => d.failure === 'failed');
  if (!broken) throw new Error('Missing fictional causal deployment');
  return validateSnapshot({
    ...basis,
    collection_complete: true,
    deployment_history_complete: true,
    recovery_evidence_complete: true,
    services: basis.services.map((service) => ({
      ...service,
      source_refs: [...service.source_refs, 'urn:clio:mock:complete-fixture-census:v1'],
      extensions: {
        ...service.extensions,
        fictional_fixture: {
          version: 1,
          coverage: 'complete within fictional fixture',
          census: roster.map((entry) => `fictional-${entry.name}`),
          history_origin: basis.window.start,
          history_end: basis.window.end,
          earlier_deployments: [],
          recovery_episode_census: ['fictional-outage'],
        },
      },
    })),
    deployments,
    changes: roster.map((entry) => ({
      id: `fictional-change-${entry.name}`,
      repository_id: `fictional-application-${entry.name}`,
      commit_id: entry.commit,
      committed_at: entry.committedAt,
      observed_at: observedAt,
      source_refs: [`urn:clio:mock:independent:source-commit:${entry.name}`],
    })),
    incidents: [
      {
        id: 'fictional-outage',
        service_id: broken.service_id,
        causal_deployment_id: broken.id,
        failure_started_at: '2026-01-02T10:05:00.000Z',
        restored_at: '2026-01-02T10:35:00.000Z',
        start_is_approximate: false,
        observed_at: observedAt,
        source_refs: ['urn:clio:mock:independent:exact-recovery-episode:v1'],
      },
    ],
  });
}
