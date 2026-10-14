import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/pool.ts';
import { suppressMemberNotifications } from '../notifications/events.ts';
import { createRepository } from '../workspaces/repository.ts';
import { email, IdentityError, invitationToken, name, opaqueId, uuid } from './input.ts';

export interface Actor {
  userId: string;
  sessionId: string;
}

async function currentUser(client: PoolClient, actor: Actor) {
  const result = await client.query<Record<string, unknown>>(
    `
    SELECT u.email, u.email_verified FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
    WHERE s.id = $1 AND s.user_id = $2 AND s.expires_at > clock_timestamp()
    FOR SHARE OF s, u`,
    [opaqueId(actor.sessionId), opaqueId(actor.userId)],
  );
  const user = result.rows[0];
  if (!user) throw new IdentityError(401, 'unauthorized');
  return user;
}

async function member(client: PoolClient, actor: Actor, workspaceId: string, owner: boolean) {
  // All workspace operations take this same lock before membership/invitation
  // changes. Revocation cannot race a detached authorization decision.
  const workspace = await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [
    workspaceId,
  ]);
  if (!workspace.rowCount) throw new IdentityError(404, 'not_found');
  const result = await client.query<Record<string, unknown>>(
    'SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
    [workspaceId, actor.userId],
  );
  const role = result.rows[0]?.role;
  if (role !== 'owner' && role !== 'member') throw new IdentityError(404, 'not_found');
  if (owner && role !== 'owner') throw new IdentityError(403, 'forbidden');
}

/** Session and membership remain locked until the scoped storage operation completes. */
export function authorizedWorkspaceTransaction<T>(
  pool: Pool,
  actor: Actor,
  workspaceId: string,
  owner: boolean,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const id = uuid(workspaceId);
  return withTransaction(pool, async (client) => {
    await currentUser(client, actor);
    await member(client, actor, id, owner);
    return operation(client);
  });
}

function hash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function createIdentityRepository(pool: Pool) {
  function transaction<T>(
    actor: Actor,
    operation: (client: PoolClient, user: Record<string, unknown>) => Promise<T>,
  ) {
    return withTransaction(pool, async (client) =>
      operation(client, await currentUser(client, actor)),
    );
  }
  function scoped<T>(
    actor: Actor,
    workspaceId: string,
    owner: boolean,
    operation: (client: PoolClient) => Promise<T>,
  ) {
    return authorizedWorkspaceTransaction(pool, actor, workspaceId, owner, operation);
  }
  return {
    async listWorkspaces(actor: Actor) {
      return transaction(actor, async (client) => {
        const result = await client.query<{ id: string; name: string; role: 'owner' | 'member' }>(
          `
          SELECT w.id, w.name, m.role FROM workspaces w JOIN workspace_memberships m ON m.workspace_id = w.id
          WHERE m.user_id = $1 ORDER BY w.name, w.id`,
          [actor.userId],
        );
        return result.rows;
      });
    },
    async createWorkspace(actor: Actor, workspaceName: unknown) {
      const normalized = name(workspaceName);
      return transaction(actor, async (client) => {
        const workspace = await createRepository(client).createWorkspace(randomUUID(), normalized);
        await client.query(
          "INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')",
          [workspace.id, actor.userId],
        );
        return { ...workspace, role: 'owner' as const };
      });
    },
    async listServices(actor: Actor, workspaceId: string) {
      return scoped(actor, workspaceId, false, (client) =>
        createRepository(client).listServices(workspaceId),
      );
    },
    async listMembers(actor: Actor, workspaceId: string, suppliedCursor?: unknown) {
      const cursor = suppliedCursor === undefined ? null : opaqueId(suppliedCursor);
      return scoped(actor, workspaceId, true, async (client) => {
        if (cursor !== null) {
          const found = await client.query(
            'SELECT 1 FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
            [workspaceId, cursor],
          );
          if (!found.rowCount) throw new IdentityError(404, 'not_found');
        }
        const result = await client.query<{
          userId: string;
          name: string;
          email: string;
          role: 'owner' | 'member';
          createdAt: Date;
        }>(
          `SELECT m.user_id AS "userId", u.name, u.email, m.role, m.created_at AS "createdAt"
           FROM workspace_memberships m JOIN auth_users u ON u.id = m.user_id
           WHERE m.workspace_id = $1 AND ($2::text IS NULL OR m.user_id > $2)
           ORDER BY m.user_id LIMIT 101`,
          [workspaceId, cursor],
        );
        return {
          workspaceId,
          members: result.rows.slice(0, 100).map((row) => ({
            userId: row.userId,
            name: row.name,
            email: row.email,
            role: row.role,
            createdAt: row.createdAt.toISOString(),
          })),
          hasMore: result.rows.length > 100,
          nextCursor: result.rows.length > 100 ? (result.rows[99]?.userId ?? null) : null,
        };
      });
    },
    async listInvitations(actor: Actor, workspaceId: string, suppliedCursor?: unknown) {
      const cursor = suppliedCursor === undefined ? null : uuid(suppliedCursor);
      return scoped(actor, workspaceId, true, async (client) => {
        if (cursor !== null) {
          const found = await client.query(
            `SELECT 1 FROM workspace_invitations WHERE workspace_id = $1 AND id = $2
             AND consumed_at IS NULL AND cancelled_at IS NULL AND expires_at > clock_timestamp()`,
            [workspaceId, cursor],
          );
          if (!found.rowCount) throw new IdentityError(404, 'not_found');
        }
        const result = await client.query<{
          id: string;
          email: string;
          createdAt: Date;
          expiresAt: Date;
        }>(
          `SELECT id, email, created_at AS "createdAt", expires_at AS "expiresAt"
           FROM workspace_invitations WHERE workspace_id = $1
           AND consumed_at IS NULL AND cancelled_at IS NULL AND expires_at > clock_timestamp()
           AND ($2::uuid IS NULL OR id > $2) ORDER BY id LIMIT 101`,
          [workspaceId, cursor],
        );
        return {
          workspaceId,
          invitations: result.rows.slice(0, 100).map((row) => ({
            id: row.id,
            email: row.email,
            status: 'pending' as const,
            createdAt: row.createdAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
          })),
          hasMore: result.rows.length > 100,
          nextCursor: result.rows.length > 100 ? (result.rows[99]?.id ?? null) : null,
        };
      });
    },
    async createService(actor: Actor, workspaceId: string, serviceName: unknown) {
      const normalized = name(serviceName);
      return scoped(actor, workspaceId, true, (client) =>
        createRepository(client).createService(workspaceId, normalized),
      );
    },
    async invite(actor: Actor, workspaceId: string, targetEmail: unknown) {
      const addressed = email(targetEmail);
      return scoped(actor, workspaceId, true, async (client) => {
        const token = randomBytes(32).toString('base64url');
        const id = randomUUID();
        const result = await client.query<{ expires_at: Date }>(
          `
          INSERT INTO workspace_invitations (id, workspace_id, email, token_hash, created_by)
          VALUES ($1, $2, $3, $4, $5) RETURNING expires_at`,
          [id, workspaceId, addressed, hash(token), actor.userId],
        );
        const expiresAt = result.rows[0]?.expires_at;
        if (!expiresAt) throw new Error('Invitation insert failed');
        return {
          id,
          workspaceId: uuid(workspaceId),
          email: addressed,
          expiresAt: expiresAt.toISOString(),
          token,
        };
      });
    },
    async cancelInvitation(actor: Actor, workspaceId: string, invitationId: string) {
      const id = uuid(invitationId);
      return scoped(actor, workspaceId, true, async (client) => {
        const result = await client.query(
          `UPDATE workspace_invitations SET cancelled_at = clock_timestamp()
          WHERE id = $1 AND workspace_id = $2 AND consumed_at IS NULL AND cancelled_at IS NULL RETURNING id`,
          [id, workspaceId],
        );
        if (!result.rowCount) throw new IdentityError(404, 'not_found');
      });
    },
    async acceptInvitation(actor: Actor, suppliedToken: unknown) {
      const tokenHash = hash(invitationToken(suppliedToken));
      return transaction(actor, async (client, user) => {
        const found = await client.query<{ workspace_id: string }>(
          'SELECT workspace_id FROM workspace_invitations WHERE token_hash = $1',
          [tokenHash],
        );
        const workspaceId = found.rows[0]?.workspace_id;
        if (!workspaceId) throw new IdentityError(404, 'not_found');
        await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspaceId]);
        const result = await client.query<Record<string, unknown>>(
          `SELECT id, email FROM workspace_invitations
          WHERE token_hash = $1 AND consumed_at IS NULL AND cancelled_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE`,
          [tokenHash],
        );
        const invitation = result.rows[0];
        if (
          !invitation ||
          user.email_verified !== true ||
          typeof user.email !== 'string' ||
          user.email.toLowerCase() !== invitation.email
        )
          throw new IdentityError(404, 'not_found');
        await client.query(
          `INSERT INTO workspace_memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')
          ON CONFLICT (workspace_id, user_id) DO NOTHING`,
          [workspaceId, actor.userId],
        );
        await client.query(
          'UPDATE workspace_invitations SET consumed_at = clock_timestamp() WHERE id = $1',
          [invitation.id],
        );
        return { workspaceId };
      });
    },
    async invitationStatus(actor: Actor, workspaceId: string, invitationId: string) {
      const id = uuid(invitationId);
      return scoped(actor, workspaceId, true, async (client) => {
        const result = await client.query<{ pending: boolean }>(
          `SELECT consumed_at IS NULL AND cancelled_at IS NULL AND expires_at > clock_timestamp() AS pending
           FROM workspace_invitations WHERE workspace_id = $1 AND id = $2`,
          [workspaceId, id],
        );
        return { pending: result.rows[0]?.pending ?? false };
      });
    },
    async revokeMember(actor: Actor, workspaceId: string, suppliedUserId: unknown) {
      const userId = opaqueId(suppliedUserId);
      return scoped(actor, workspaceId, true, async (client) => {
        const target = await client.query<{ role: string }>(
          'SELECT role FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
          [workspaceId, userId],
        );
        const role = target.rows[0]?.role;
        if (!role) throw new IdentityError(404, 'not_found');
        if (role === 'owner') {
          const owners = await client.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM workspace_memberships WHERE workspace_id = $1 AND role = 'owner'",
            [workspaceId],
          );
          if ((owners.rows[0]?.count ?? 0) <= 1) throw new IdentityError(409, 'last_owner');
          throw new IdentityError(409, 'owner_protected');
        }
        // An earlier invitation must not undo revocation. A later explicit
        // invitation can grant access again; cancellation is scoped to this
        // workspace and the target's current email.
        const cancelled = await client.query<{ ids: string[]; has_more: boolean }>(
          `WITH cancelled AS (
            UPDATE workspace_invitations SET cancelled_at = clock_timestamp()
            WHERE workspace_id = $1 AND email = (SELECT lower(email) FROM auth_users WHERE id = $2)
              AND consumed_at IS NULL AND cancelled_at IS NULL
            RETURNING id
          )
          SELECT ARRAY(SELECT id FROM cancelled ORDER BY id LIMIT 100) AS ids,
                 (SELECT count(*) > 100 FROM cancelled) AS has_more`,
          [workspaceId, userId],
        );
        // Same transaction as the deletion: pending notices, link and link states are invalidated.
        await suppressMemberNotifications(client, workspaceId, userId);
        await client.query(
          'DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2',
          [workspaceId, userId],
        );
        return {
          cancelledInvitationIds: cancelled.rows[0]?.ids ?? [],
          hasMore: cancelled.rows[0]?.has_more ?? false,
        };
      });
    },
  };
}
