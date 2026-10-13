import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { IdentityError, object, uuid } from '../identity/input.ts';
import { type Actor, authorizedWorkspaceTransaction } from '../identity/repository.ts';
import {
  type NotificationConfig,
  type NotificationGrant,
  notificationGrant,
  readNotificationConfig,
} from './config.ts';
import { field } from './http.ts';
import {
  createSlackIdentityProvider,
  type SlackIdentityProvider,
  slackCallbackUri,
} from './slack-identity.ts';

/** Safe callback failure. workspaceId exists only after stored actor/session binding is proven. */
export class SlackLinkError extends IdentityError {
  readonly workspaceId: string | undefined;
  constructor(status: number, message: string, workspaceId?: string) {
    super(status, message);
    this.workspaceId = workspaceId;
  }
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
function corrupt(): never {
  throw new IdentityError(500, 'invalid_notification_record');
}
function storedString(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) corrupt();
  return value;
}
function revision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2147483646)
    corrupt();
  return value;
}
function instant(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) corrupt();
  return value.toISOString();
}
/** Private, exact binding projection for trusted delivery code. Caller checks current grant. */
export async function readSlackBinding(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<{
  teamId: string;
  userId: string;
  grantFingerprint: string;
  revision: number;
  linkedAt: string;
} | null> {
  const result = await client.query<Record<string, unknown>>(
    'SELECT team_id,slack_user_id,grant_fingerprint,revision,linked_at FROM notification_slack_bindings WHERE workspace_id=$1 AND user_id=$2',
    [workspaceId, userId],
  );
  const row = result.rows[0];
  if (!row || row.slack_user_id === null) return null;
  return {
    teamId: storedString(row.team_id, /^T[A-Z0-9]+$/),
    userId: storedString(row.slack_user_id, /^[UW][A-Z0-9]+$/),
    grantFingerprint: storedString(row.grant_fingerprint, /^[0-9a-f]{64}$/),
    revision: revision(row.revision),
    linkedAt: instant(row.linked_at),
  };
}
async function bindingRevision(
  client: PoolClient,
  workspaceId: string,
  userId: string,
): Promise<number> {
  const result = await client.query<Record<string, unknown>>(
    'SELECT revision FROM notification_slack_bindings WHERE workspace_id=$1 AND user_id=$2',
    [workspaceId, userId],
  );
  return result.rows[0] ? revision(result.rows[0].revision) : 0;
}
function callbackInput(value: unknown): { state: string; code: string | null } {
  try {
    const input = object(value, ['state', 'code', 'error', 'error_description']);
    if (typeof input.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.state))
      throw new Error();
    if (input.error !== undefined) {
      if (
        input.code !== undefined ||
        typeof input.error !== 'string' ||
        !input.error ||
        input.error.length > 256 ||
        (input.error_description !== undefined &&
          (typeof input.error_description !== 'string' || input.error_description.length > 4096))
      )
        throw new Error();
      return { state: input.state, code: null };
    }
    if (
      input.error_description !== undefined ||
      typeof input.code !== 'string' ||
      !input.code ||
      input.code.length > 4096 ||
      /\s/u.test(input.code) ||
      Array.from(input.code).some(
        (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error();
    return { state: input.state, code: input.code };
  } catch {
    throw new SlackLinkError(400, 'invalid_request');
  }
}
type State = Readonly<{
  workspaceId: string;
  teamId: string;
  nonceHash: string;
  grantFingerprint: string;
  credentialFingerprint: string;
  bindingRevision: number;
}>;
function storedState(row: Record<string, unknown>): State {
  return {
    workspaceId: uuid(row.workspace_id),
    teamId: storedString(row.team_id, /^T[A-Z0-9]+$/),
    nonceHash: storedString(row.nonce_hash, /^[0-9a-f]{64}$/),
    grantFingerprint: storedString(row.grant_fingerprint, /^[0-9a-f]{64}$/),
    credentialFingerprint: storedString(row.credential_fingerprint, /^[0-9a-f]{64}$/),
    bindingRevision: revision(row.binding_revision),
  };
}
function fenced(grant: NotificationGrant | null, state: State): NotificationGrant {
  if (
    !grant?.slack ||
    grant.slack.teamId !== state.teamId ||
    grant.fingerprint !== state.grantFingerprint ||
    grant.credentialFingerprint !== state.credentialFingerprint
  )
    throw new IdentityError(409, 'conflict');
  return grant;
}
export function createSlackLinkRepository(
  pool: Pool,
  _config: NotificationConfig | null,
  identityProvider?: SlackIdentityProvider,
  dependencies: {
    configNow?: () => Promise<NotificationConfig | null>;
    callbackOrigin?: string;
  } = {},
) {
  const configNow = dependencies.configNow ?? (() => readNotificationConfig(process.env));
  async function configuration(): Promise<NotificationConfig | null> {
    try {
      return await configNow();
    } catch {
      throw new IdentityError(503, 'unavailable');
    }
  }
  return {
    async begin(actor: Actor, workspaceId: string): Promise<{ authorizeUrl: string }> {
      const id = uuid(workspaceId);
      return authorizedWorkspaceTransaction(pool, actor, id, false, async (client) => {
        const config = await configuration();
        const grant = notificationGrant(config, id);
        if (!config || !grant?.slack) throw new IdentityError(409, 'conflict');
        const redirectUri = slackCallbackUri(dependencies.callbackOrigin ?? config.publicOrigin);
        const state = randomBytes(32).toString('base64url');
        const nonce = randomBytes(32).toString('base64url');
        const currentRevision = await bindingRevision(client, id, actor.userId);
        // A fresh consent flow supersedes this session's unfinished flows; consumed replay markers remain.
        await client.query(
          'DELETE FROM notification_oauth_states WHERE workspace_id=$1 AND user_id=$2 AND (expires_at<=clock_timestamp() OR (session_id=$3 AND consumed_at IS NULL))',
          [id, actor.userId, actor.sessionId],
        );
        await client.query(
          `INSERT INTO notification_oauth_states(state_hash,nonce_hash,workspace_id,user_id,session_id,team_id,grant_fingerprint,credential_fingerprint,binding_revision)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            hash(state),
            hash(nonce),
            id,
            actor.userId,
            actor.sessionId,
            grant.slack.teamId,
            grant.fingerprint,
            grant.credentialFingerprint,
            currentRevision,
          ],
        );
        const url = new URL('https://slack.com/openid/connect/authorize');
        url.search = new URLSearchParams({
          response_type: 'code',
          response_mode: 'query',
          scope: 'openid profile',
          client_id: grant.slack.clientId,
          team: grant.slack.teamId,
          state,
          nonce,
          redirect_uri: redirectUri,
        }).toString();
        return { authorizeUrl: url.href };
      });
    },
    async complete(
      actor: Actor,
      callback: unknown,
    ): Promise<{ workspaceId: string; linked: true }> {
      const input = callbackInput(callback);
      const stateHash = hash(input.state);
      let trustedWorkspace: string | undefined;
      try {
        const lookup = await pool.query<Record<string, unknown>>(
          'SELECT workspace_id FROM notification_oauth_states WHERE state_hash=$1 AND user_id=$2 AND session_id=$3',
          [stateHash, actor.userId, actor.sessionId],
        );
        const original = lookup.rows[0];
        // Deleted membership/session states and unknown states have indistinguishable failures.
        if (!original) throw new SlackLinkError(404, 'not_found');
        trustedWorkspace = uuid(original.workspace_id);
        const state = await authorizedWorkspaceTransaction(
          pool,
          actor,
          trustedWorkspace,
          false,
          async (client) => {
            const result = await client.query<Record<string, unknown>>(
              `UPDATE notification_oauth_states SET consumed_at=clock_timestamp()
            WHERE state_hash=$1 AND user_id=$2 AND session_id=$3 AND workspace_id=$4 AND consumed_at IS NULL AND expires_at>clock_timestamp()
            RETURNING workspace_id,team_id,nonce_hash,grant_fingerprint,credential_fingerprint,binding_revision`,
              [stateHash, actor.userId, actor.sessionId, trustedWorkspace],
            );
            const row = result.rows[0];
            if (!row) throw new IdentityError(400, 'invalid_slack_state');
            return storedState(row);
          },
        );
        if (input.code === null) throw new IdentityError(400, 'slack_link_denied');
        const config = await configuration();
        const grant = fenced(notificationGrant(config, state.workspaceId), state);
        if (!config) throw new IdentityError(409, 'conflict');
        const provider =
          identityProvider ??
          createSlackIdentityProvider(dependencies.callbackOrigin ?? config.publicOrigin);
        const signal = AbortSignal.timeout(10_000);
        let verified: { teamId: string; userId: string };
        let onAbort = () => {};
        const aborted = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new IdentityError(400, 'invalid_slack_identity'));
          signal.addEventListener('abort', onAbort, { once: true });
        });
        try {
          // Race also bounds injected providers that ignore cancellation.
          verified = await Promise.race([
            provider.verifyCode({ code: input.code, nonceHash: state.nonceHash, grant, signal }),
            aborted,
          ]);
        } catch {
          throw new IdentityError(400, 'invalid_slack_identity');
        } finally {
          signal.removeEventListener('abort', onAbort);
        }
        if (verified.teamId !== state.teamId || !/^[UW][A-Z0-9]+$/.test(verified.userId))
          throw new IdentityError(400, 'invalid_slack_identity');
        return await authorizedWorkspaceTransaction(
          pool,
          actor,
          state.workspaceId,
          false,
          async (client) => {
            fenced(notificationGrant(await configuration(), state.workspaceId), state);
            const retained = await client.query(
              'SELECT 1 FROM notification_oauth_states WHERE state_hash=$1 AND user_id=$2 AND session_id=$3 AND consumed_at IS NOT NULL AND expires_at>clock_timestamp()',
              [stateHash, actor.userId, actor.sessionId],
            );
            if (
              !retained.rowCount ||
              (await bindingRevision(client, state.workspaceId, actor.userId)) !==
                state.bindingRevision
            )
              throw new IdentityError(409, 'conflict');
            try {
              await client.query(
                `INSERT INTO notification_slack_bindings(workspace_id,user_id,revision,team_id,slack_user_id,grant_fingerprint,linked_at)
              VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()) ON CONFLICT(workspace_id,user_id) DO UPDATE SET
              revision=EXCLUDED.revision,team_id=EXCLUDED.team_id,slack_user_id=EXCLUDED.slack_user_id,grant_fingerprint=EXCLUDED.grant_fingerprint,linked_at=EXCLUDED.linked_at,updated_at=clock_timestamp()`,
                [
                  state.workspaceId,
                  actor.userId,
                  state.bindingRevision + 1,
                  verified.teamId,
                  verified.userId,
                  state.grantFingerprint,
                ],
              );
            } catch (error) {
              if (
                field(error, 'code') === '23505' &&
                field(error, 'constraint') ===
                  'notification_slack_bindings_workspace_id_team_id_slack_user_key'
              )
                throw new IdentityError(409, 'conflict');
              throw new IdentityError(503, 'unavailable');
            }
            return { workspaceId: state.workspaceId, linked: true };
          },
        );
      } catch (error) {
        if (error instanceof SlackLinkError) throw error;
        if (error instanceof IdentityError)
          throw new SlackLinkError(error.status, error.message, trustedWorkspace);
        throw new SlackLinkError(503, 'unavailable', trustedWorkspace);
      }
    },
  };
}
