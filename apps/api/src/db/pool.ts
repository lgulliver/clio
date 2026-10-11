import { Pool, type PoolClient } from 'pg';

export function createPool(connectionString: string) {
  const pool = new Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 3000,
    idleTimeoutMillis: 10000,
    statement_timeout: 5000,
  });
  // Idle connection failures must not become unhandled EventEmitter errors.
  // Deliberately avoid logging connection strings or database error payloads.
  pool.on('error', () => console.error('Database idle connection failed'));
  return pool;
}

export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      discard = true;
    }
    throw error;
  } finally {
    client.release(discard);
  }
}

/** Required measurement columns belong to the assigned persistent foundation. */
export async function checkMeasurementColumns(pool: Pool): Promise<void> {
  await pool.query(
    'SELECT workspace_id,service_id,provider,source_scope,retained_facts,retained_bytes,rate_started_at,rate_requests FROM measurement_source_budgets LIMIT 0',
  );
  await pool.query(
    'SELECT id,workspace_id,service_id,provider,source_scope,basis_run_id,producer_id,capability,event_id,report,digest,basis,native_fingerprint,authority_fingerprint,fact_count,payload_bytes,received_at FROM measurement_reports LIMIT 0',
  );
  await pool.query(
    'SELECT id,workspace_id,service_id,provider,source_scope,basis_run_id,request_id,input,status,attempts,created_at,updated_at,available_at,completed_at,failure_code,result,lease_token,lease_until FROM measurement_runs LIMIT 0',
  );
  await pool.query(
    'SELECT run_id,workspace_id,service_id,snapshot,metrics,lineage,public_result,digest FROM measurement_snapshots LIMIT 0',
  );
}
