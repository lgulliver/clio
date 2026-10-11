import { calculate, type Dataset, type MetricResult, validateSnapshot } from '@clio/oems';

// Fictional observations, passed through the actual pinned calculation.
export function metricFixture(
  complete = false,
  empty = false,
  mixedRecovery = false,
  unknownClassification = false,
): MetricResult {
  const observed = '2026-01-04T00:01:00.000001Z';
  const data: Dataset = {
    dataset_id: 'urn:fictional:metrics',
    profile_version: '0.1-draft',
    snapshot_as_of_cutoff: true,
    window: {
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-03T00:00:00Z',
      timezone: 'UTC',
      calendar_days: 2,
    },
    evidence_cutoff: observed,
    collection_complete: complete,
    deployment_history_complete: complete,
    recovery_evidence_complete: complete,
    services: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        name: 'Fictional service',
        observed_at: observed,
        source_refs: ['urn:fictional:service'],
      },
    ],
    changes: empty
      ? []
      : [
          {
            id: 'change:one',
            source_refs: ['urn:fictional:change'],
            repository_id: 'fictional:repo',
            commit_id: 'fictional:commit',
            committed_at: '2026-01-01T01:00:00Z',
            observed_at: observed,
          },
        ],
    deployments: empty
      ? []
      : [
          {
            id: 'deployment:one',
            source_refs: ['urn:fictional:deployment'],
            service_id: '33333333-3333-4333-8333-333333333333',
            rollout_group_id: 'rollout:one',
            environment: 'production',
            qualification: 'qualifying',
            effective_at: '2026-01-02T01:00:00Z',
            change_ids: ['change:one'],
            failure: 'failed',
            rework: 'not_incident_driven',
            observed_at: observed,
            change_links_complete: true,
            qualification_window: null,
            failure_evidence_refs: ['urn:fictional:incident'],
            rework_evidence_refs: ['urn:fictional:rework'],
          },
        ],
    incidents: empty
      ? []
      : [
          {
            id: 'incident:one',
            source_refs: ['urn:fictional:incident'],
            service_id: '33333333-3333-4333-8333-333333333333',
            causal_deployment_id: 'deployment:one',
            failure_started_at: '2026-01-02T01:00:00Z',
            restored_at: '2026-01-02T01:10:00Z',
            start_is_approximate: false,
            observed_at: observed,
          },
        ],
  };
  if (unknownClassification) {
    const deployment = data.deployments[0];
    if (!deployment) throw new Error('Missing fictional deployment');
    deployment.failure = 'unknown';
    deployment.rework = 'unknown';
    deployment.failure_evidence_refs = [];
    deployment.rework_evidence_refs = [];
    data.incidents = [];
  }
  if (mixedRecovery) {
    const exact = data.incidents[0];
    if (!exact) throw new Error('Missing fictional episode');
    data.incidents.push(
      {
        ...exact,
        id: 'incident:approximate',
        start_is_approximate: true,
        restored_at: '2026-01-02T01:02:00Z',
      },
      { ...exact, id: 'incident:open', restored_at: null },
    );
  }
  const checked = validateSnapshot(data);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  const metric = calculate(checked.data)[0];
  if (!metric) throw new Error('Missing fictional metric');
  return metric;
}

export function withMetric<
  T extends {
    deploymentCount: number;
    qualifyingCount: number;
    unknownCount: number;
    deploymentFrequency: {
      count: number;
      status: 'provisional';
      deploymentsPerDay: null;
      qualityReasons: string[];
    };
    failedDeploymentRecoveryTime: number | null;
  },
>(summary: T) {
  const metricResult = metricFixture();
  return {
    ...summary,
    metricResult,
    deploymentCount: 1,
    qualifyingCount: 1,
    unknownCount: 0,
    deploymentFrequency: {
      ...summary.deploymentFrequency,
      count: metricResult.deployment_frequency.count,
      qualityReasons: metricResult.deployment_frequency.quality_reasons,
    },
    failedDeploymentRecoveryTime: metricResult.failed_deployment_recovery_time.median_seconds,
  };
}
