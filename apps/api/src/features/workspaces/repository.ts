import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export interface Workspace {
  id: string;
  name: string;
}
export interface Service {
  id: string;
  workspaceId: string;
  name: string;
}

function uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new Error('Expected UUID');
  }
  return value.toLowerCase();
}

function name(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Name must contain 1 to 200 characters');
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length === 0 || length > 200) throw new Error('Name must contain 1 to 200 characters');
  return normalized;
}

function workspace(row: Record<string, unknown>): Workspace {
  return { id: uuid(row.id), name: name(row.name) };
}

function service(row: Record<string, unknown>): Service {
  return { id: uuid(row.id), workspaceId: uuid(row.workspace_id), name: name(row.name) };
}

// Internal persistence only. Callers must establish membership before invoking
// these methods; explicit scope prevents accidental unscoped queries, not auth.
export function createRepository(db: Pool | PoolClient) {
  return {
    async createWorkspace(workspaceId: string, workspaceName: unknown): Promise<Workspace> {
      const result = await db.query<Record<string, unknown>>(
        'INSERT INTO workspaces (id, name) VALUES ($1, $2) RETURNING id, name',
        [uuid(workspaceId), name(workspaceName)],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Workspace insert returned no row');
      return workspace(row);
    },
    async getWorkspace(workspaceId: string): Promise<Workspace | null> {
      const result = await db.query<Record<string, unknown>>(
        'SELECT id, name FROM workspaces WHERE id = $1',
        [uuid(workspaceId)],
      );
      const row = result.rows[0];
      return row ? workspace(row) : null;
    },
    async createService(workspaceId: string, serviceName: unknown): Promise<Service> {
      const result = await db.query<Record<string, unknown>>(
        'INSERT INTO services (id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id, workspace_id, name',
        [randomUUID(), uuid(workspaceId), name(serviceName)],
      );
      const row = result.rows[0];
      if (!row) throw new Error('Service insert returned no row');
      return service(row);
    },
    async getService(workspaceId: string, serviceId: string): Promise<Service | null> {
      const result = await db.query<Record<string, unknown>>(
        'SELECT id, workspace_id, name FROM services WHERE workspace_id = $1 AND id = $2',
        [uuid(workspaceId), uuid(serviceId)],
      );
      const row = result.rows[0];
      return row ? service(row) : null;
    },
    async listServices(workspaceId: string): Promise<Service[]> {
      const result = await db.query<Record<string, unknown>>(
        'SELECT id, workspace_id, name FROM services WHERE workspace_id = $1 ORDER BY name, id',
        [uuid(workspaceId)],
      );
      return result.rows.map(service);
    },
  };
}
