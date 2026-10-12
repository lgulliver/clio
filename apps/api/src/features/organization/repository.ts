import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { IdentityError, name, uuid } from '../identity/input.ts';
import { type Actor, authorizedWorkspaceTransaction } from '../identity/repository.ts';
import type { Service } from '../workspaces/repository.ts';

export interface Team {
  id: string;
  workspaceId: string;
  name: string;
}
export interface Product extends Team {
  teamId: string;
}
export interface Assignment {
  serviceId: string;
  productId: string | null;
}
export interface Organization {
  workspaceId: string;
  teams: Team[];
  products: Product[];
  assignments: Assignment[];
  services: Service[];
}

function team(row: Record<string, unknown>): Team {
  return { id: uuid(row.id), workspaceId: uuid(row.workspace_id), name: name(row.name) };
}
function product(row: Record<string, unknown>): Product {
  return { ...team(row), teamId: uuid(row.team_id) };
}
function assignment(row: Record<string, unknown>): Assignment {
  return {
    serviceId: uuid(row.id),
    productId: row.product_id === null ? null : uuid(row.product_id),
  };
}

export function createOrganizationRepository(pool: Pool) {
  return {
    async read(actor: Actor, workspaceId: string): Promise<Organization> {
      const id = uuid(workspaceId);
      return authorizedWorkspaceTransaction(pool, actor, id, false, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          `SELECT
            (SELECT COALESCE(jsonb_agg(t ORDER BY t.name, t.id), '[]'::jsonb)
             FROM (SELECT id, workspace_id, name FROM teams WHERE workspace_id = $1) t) AS teams,
            (SELECT COALESCE(jsonb_agg(p ORDER BY p.name, p.id), '[]'::jsonb)
             FROM (SELECT id, workspace_id, team_id, name FROM products WHERE workspace_id = $1) p) AS products,
            (SELECT COALESCE(jsonb_agg(s ORDER BY s.name, s.id), '[]'::jsonb)
             FROM (SELECT id, workspace_id, name, product_id FROM services WHERE workspace_id = $1) s) AS services`,
          [id],
        );
        const snapshot = result.rows[0];
        if (!snapshot) throw new Error('Organization read returned no row');
        const rows = (value: unknown): Record<string, unknown>[] => {
          if (!Array.isArray(value)) throw new Error('Invalid organization rows');
          return value.map((item: unknown) => {
            if (typeof item !== 'object' || item === null || Array.isArray(item))
              throw new Error('Invalid organization row');
            return Object.fromEntries(Object.entries(item));
          });
        };
        const services = rows(snapshot.services);
        return {
          workspaceId: id,
          teams: rows(snapshot.teams).map(team),
          products: rows(snapshot.products).map(product),
          services: services.map((row) => ({
            id: uuid(row.id),
            workspaceId: uuid(row.workspace_id),
            name: name(row.name),
          })),
          assignments: services.map(assignment),
        };
      });
    },
    async createTeam(actor: Actor, workspaceId: string, teamName: unknown): Promise<Team> {
      const id = uuid(workspaceId);
      const normalized = name(teamName);
      return authorizedWorkspaceTransaction(pool, actor, id, true, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          'INSERT INTO teams (id, workspace_id, name) VALUES ($1, $2, $3) RETURNING id, workspace_id, name',
          [randomUUID(), id, normalized],
        );
        const row = result.rows[0];
        if (!row) throw new Error('Team insert returned no row');
        return team(row);
      });
    },
    async createProduct(
      actor: Actor,
      workspaceId: string,
      teamId: unknown,
      productName: unknown,
    ): Promise<Product> {
      const id = uuid(workspaceId);
      const parent = uuid(teamId);
      const normalized = name(productName);
      return authorizedWorkspaceTransaction(pool, actor, id, true, async (client) => {
        const found = await client.query(
          'SELECT id FROM teams WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
          [id, parent],
        );
        if (!found.rowCount) throw new IdentityError(404, 'not_found');
        const result = await client.query<Record<string, unknown>>(
          'INSERT INTO products (id, workspace_id, team_id, name) VALUES ($1, $2, $3, $4) RETURNING id, workspace_id, team_id, name',
          [randomUUID(), id, parent, normalized],
        );
        const row = result.rows[0];
        if (!row) throw new Error('Product insert returned no row');
        return product(row);
      });
    },
    async updateTeam(
      actor: Actor,
      workspaceId: string,
      teamId: string,
      teamName: unknown,
    ): Promise<Team> {
      const id = uuid(workspaceId);
      const target = uuid(teamId);
      const normalized = name(teamName);
      return authorizedWorkspaceTransaction(pool, actor, id, true, async (client) => {
        const result = await client.query<Record<string, unknown>>(
          'UPDATE teams SET name = $3 WHERE workspace_id = $1 AND id = $2 RETURNING id, workspace_id, name',
          [id, target, normalized],
        );
        const row = result.rows[0];
        if (!row) throw new IdentityError(404, 'not_found');
        return team(row);
      });
    },
    async updateProduct(
      actor: Actor,
      workspaceId: string,
      productId: string,
      teamId: unknown,
      productName: unknown,
    ): Promise<Product> {
      const id = uuid(workspaceId);
      const target = uuid(productId);
      const parent = uuid(teamId);
      const normalized = name(productName);
      return authorizedWorkspaceTransaction(pool, actor, id, true, async (client) => {
        const found = await client.query(
          'SELECT id FROM teams WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
          [id, parent],
        );
        if (!found.rowCount) throw new IdentityError(404, 'not_found');
        const result = await client.query<Record<string, unknown>>(
          'UPDATE products SET name = $3, team_id = $4 WHERE workspace_id = $1 AND id = $2 RETURNING id, workspace_id, team_id, name',
          [id, target, normalized, parent],
        );
        const row = result.rows[0];
        if (!row) throw new IdentityError(404, 'not_found');
        return product(row);
      });
    },
    async deleteTeam(actor: Actor, workspaceId: string, teamId: string): Promise<string> {
      const id = uuid(workspaceId);
      const target = uuid(teamId);
      return authorizedWorkspaceTransaction(pool, actor, id, true, async (client) => {
        const found = await client.query(
          'SELECT id FROM teams WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
          [id, target],
        );
        if (!found.rowCount) throw new IdentityError(404, 'not_found');
        const children = await client.query(
          'SELECT id FROM products WHERE workspace_id = $1 AND team_id = $2 LIMIT 1',
          [id, target],
        );
        if (children.rowCount) throw new IdentityError(409, 'conflict');
        await client.query('DELETE FROM teams WHERE workspace_id = $1 AND id = $2', [id, target]);
        return target;
      });
    },
    async deleteProduct(actor: Actor, workspaceId: string, productId: string): Promise<string> {
      const id = uuid(workspaceId);
      const target = uuid(productId);
      return authorizedWorkspaceTransaction(pool, actor, id, true, async (client) => {
        const found = await client.query(
          'SELECT id FROM products WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
          [id, target],
        );
        if (!found.rowCount) throw new IdentityError(404, 'not_found');
        await client.query(
          'UPDATE services SET product_id = NULL WHERE workspace_id = $1 AND product_id = $2',
          [id, target],
        );
        await client.query('DELETE FROM products WHERE workspace_id = $1 AND id = $2', [
          id,
          target,
        ]);
        return target;
      });
    },
    async assign(
      actor: Actor,
      workspaceId: string,
      serviceId: string,
      productId: unknown,
    ): Promise<Assignment> {
      const id = uuid(workspaceId);
      const service = uuid(serviceId);
      const parent = productId === null ? null : uuid(productId);
      return authorizedWorkspaceTransaction(pool, actor, id, true, async (client) => {
        if (parent !== null) {
          const found = await client.query(
            'SELECT id FROM products WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
            [id, parent],
          );
          if (!found.rowCount) throw new IdentityError(404, 'not_found');
        }
        const result = await client.query<Record<string, unknown>>(
          'UPDATE services SET product_id = $3 WHERE workspace_id = $1 AND id = $2 RETURNING id, product_id',
          [id, service, parent],
        );
        const row = result.rows[0];
        if (!row) throw new IdentityError(404, 'not_found');
        return assignment(row);
      });
    },
  };
}
