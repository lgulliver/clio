/** Types derived from vendored OEMS schemas at the pinned revision. */
export type Service = {
  id: string;
  source_refs: string[];
  extensions?: Record<string, unknown>;
  name: string;
  observed_at: string;
};
export type Change = {
  id: string;
  source_refs: string[];
  extensions?: Record<string, unknown>;
  repository_id: string;
  commit_id: string;
  committed_at: string;
  observed_at: string;
};
export type Deployment = {
  id: string;
  source_refs: string[];
  extensions?: Record<string, unknown>;
  service_id: string;
  rollout_group_id: string;
  environment: 'production' | 'non_production' | 'unknown';
  qualification: 'qualifying' | 'excluded' | 'unknown';
  effective_at: string | null;
  change_ids: string[];
  failure: 'failed' | 'no_recorded_failure' | 'unknown';
  rework: 'incident_driven' | 'not_incident_driven' | 'unknown';
  observed_at: string;
  change_links_complete: boolean;
  qualification_window: { start: string; end: string } | null;
  failure_evidence_refs: string[];
  rework_evidence_refs: string[];
};
export type Incident = {
  id: string;
  source_refs: string[];
  extensions?: Record<string, unknown>;
  service_id: string;
  causal_deployment_id: string;
  failure_started_at: string;
  restored_at: string | null;
  start_is_approximate: boolean;
  observed_at: string;
};
export type Dataset = {
  dataset_id: string;
  profile_version: '0.1-draft';
  snapshot_as_of_cutoff: true;
  window: { start: string; end: string; timezone: 'UTC'; calendar_days: number };
  evidence_cutoff: string;
  collection_complete: boolean;
  deployment_history_complete: boolean;
  recovery_evidence_complete: boolean;
  services: Service[];
  changes: Change[];
  deployments: Deployment[];
  incidents: Incident[];
};
export type MetricResult = {
  dataset_id: string;
  service_id: string;
  profile_version: '0.1-draft';
  window: { start: string; end: string; timezone: 'UTC'; calendar_days: number };
  evidence_cutoff: string;
  qualification_unknown_count: number;
  deployment_frequency: {
    status: 'complete' | 'provisional' | 'no_observations';
    quality_reasons: (
      | 'incomplete_collection'
      | 'unresolved_qualification'
      | 'unknown_failure_classification'
      | 'unknown_rework_classification'
      | 'incomplete_history'
      | 'incomplete_change_linkage'
      | 'unresolved_change_links'
      | 'incomplete_recovery_evidence'
      | 'unresolved_causal_links'
      | 'open_recovery_episodes'
      | 'approximate_recovery_start'
    )[];
    count: number;
    deployments_per_day: number | null;
  };
  change_lead_time: {
    status: 'complete' | 'provisional' | 'no_observations';
    quality_reasons: (
      | 'incomplete_collection'
      | 'unresolved_qualification'
      | 'unknown_failure_classification'
      | 'unknown_rework_classification'
      | 'incomplete_history'
      | 'incomplete_change_linkage'
      | 'unresolved_change_links'
      | 'incomplete_recovery_evidence'
      | 'unresolved_causal_links'
      | 'open_recovery_episodes'
      | 'approximate_recovery_start'
    )[];
    observation_count: number;
    candidate_count: number;
    unresolved_change_count: number;
    linkage_unknown_count: number;
    median_seconds: number | null;
  };
  change_fail_rate: {
    status: 'complete' | 'provisional' | 'no_observations';
    quality_reasons: (
      | 'incomplete_collection'
      | 'unresolved_qualification'
      | 'unknown_failure_classification'
      | 'unknown_rework_classification'
      | 'incomplete_history'
      | 'incomplete_change_linkage'
      | 'unresolved_change_links'
      | 'incomplete_recovery_evidence'
      | 'unresolved_causal_links'
      | 'open_recovery_episodes'
      | 'approximate_recovery_start'
    )[];
    numerator: number;
    denominator: number;
    unknown_count: number;
    lower_bound: number | null;
    upper_bound: number | null;
    ratio: number | null;
    bounds_scope: 'full_population' | 'observed_population';
  };
  deployment_rework_rate: {
    status: 'complete' | 'provisional' | 'no_observations';
    quality_reasons: (
      | 'incomplete_collection'
      | 'unresolved_qualification'
      | 'unknown_failure_classification'
      | 'unknown_rework_classification'
      | 'incomplete_history'
      | 'incomplete_change_linkage'
      | 'unresolved_change_links'
      | 'incomplete_recovery_evidence'
      | 'unresolved_causal_links'
      | 'open_recovery_episodes'
      | 'approximate_recovery_start'
    )[];
    numerator: number;
    denominator: number;
    unknown_count: number;
    lower_bound: number | null;
    upper_bound: number | null;
    ratio: number | null;
    bounds_scope: 'full_population' | 'observed_population';
  };
  failed_deployment_recovery_time: {
    status: 'complete' | 'provisional' | 'no_observations';
    quality_reasons: (
      | 'incomplete_collection'
      | 'unresolved_qualification'
      | 'unknown_failure_classification'
      | 'unknown_rework_classification'
      | 'incomplete_history'
      | 'incomplete_change_linkage'
      | 'unresolved_change_links'
      | 'incomplete_recovery_evidence'
      | 'unresolved_causal_links'
      | 'open_recovery_episodes'
      | 'approximate_recovery_start'
    )[];
    observation_count: number;
    open_count: number;
    approximate_count: number;
    unresolved_count: number;
    unknown_failure_count: number;
    median_seconds: number | null;
    approximate_median_seconds: number | null;
  };
};
export type EventEnvelope = {
  spec_version: '0.1-draft';
  dataset_id: string;
  event_id: string;
  record_type: 'service' | 'change' | 'deployment' | 'incident';
  source_revision?: string;
  occurred_at: string;
  observed_at: string;
  source_refs: string[];
  payload: Record<string, unknown>;
};
