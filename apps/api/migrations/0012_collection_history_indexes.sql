-- Apply only after 0011_measurement_evidence.sql is integrated in migration order.
CREATE INDEX github_collection_runs_history ON github_collection_runs(workspace_id, service_id, created_at DESC, id DESC);
CREATE INDEX github_collection_success_history ON github_collection_runs(workspace_id, service_id, created_at DESC, id DESC) WHERE status = 'succeeded';
CREATE INDEX argo_collection_runs_history ON argo_collection_runs(workspace_id, service_id, created_at DESC, id DESC);
CREATE INDEX argo_collection_success_history ON argo_collection_runs(workspace_id, service_id, created_at DESC, id DESC) WHERE status = 'succeeded';
CREATE INDEX mock_collection_runs_history ON mock_collection_runs(workspace_id, service_id, created_at DESC, id DESC);
CREATE INDEX mock_collection_success_history ON mock_collection_runs(workspace_id, service_id, created_at DESC, id DESC) WHERE status = 'succeeded';
CREATE INDEX measurement_success_history ON measurement_runs(workspace_id, service_id, created_at DESC, id DESC) WHERE status = 'succeeded';
