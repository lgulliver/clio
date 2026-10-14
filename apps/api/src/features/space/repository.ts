import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { IdentityError, object, opaqueId, uuid } from '../identity/input.ts';
import { type Actor, authorizedWorkspaceTransaction } from '../identity/repository.ts';
import {
  cancelPulseNotifications,
  capturePulseNotifications,
  closePulseNotifications,
  suppressMemberNotifications,
} from '../notifications/events.ts';
import {
  aggregateResponses,
  instrument,
  type Pulse,
  type PulseState,
  type QuestionResult,
} from './contract.ts';
import { parseAnswers, parseDraft, parseMinimum, parseResponse } from './input.ts';

interface StoredPulse {
  id: string;
  workspace_id: string;
  team_id: string;
  team_name: string;
  reference_start: Date;
  reference_end: Date;
  state: PulseState;
  minimum_respondents: number | null;
  roster_size: number | null;
  submitted_count: number | null;
  questions: unknown;
  opened_at: Date | null;
  closed_at: Date | null;
  cancelled_at: Date | null;
}
interface AssignmentRow {
  userId: string;
  teamId: string | null;
  teamName: string | null;
}
interface HistoryRow {
  id: string;
  teamId: string | null;
  teamName: string | null;
  changedAt: Date;
}
async function ownerRole(client: PoolClient, actor: Actor, workspaceId: string) {
  const result = await client.query<{ role: string }>(
    'SELECT role FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
    [workspaceId, actor.userId],
  );
  return result.rows[0]?.role === 'owner';
}
async function minimum(client: PoolClient, workspaceId: string) {
  const result = await client.query<{ minimum_respondents: number }>(
    'SELECT minimum_respondents FROM space_preferences WHERE workspace_id=$1',
    [workspaceId],
  );
  return result.rows[0]?.minimum_respondents ?? 3;
}
async function team(client: PoolClient, workspaceId: string, teamId: string) {
  const result = await client.query<{ name: string }>(
    'SELECT name FROM teams WHERE workspace_id=$1 AND id=$2',
    [workspaceId, teamId],
  );
  const found = result.rows[0];
  if (!found) throw new IdentityError(404, 'not_found');
  return found;
}
function parseResults(value: unknown, threshold: number): QuestionResult[] {
  if (!Array.isArray(value) || value.length !== instrument.questions.length)
    throw new Error('Invalid SPACE results');
  return instrument.questions.map((question, index) => {
    const row = object(value[index], ['questionId', 'status', 'mean', 'answeredCount']);
    if (row.questionId !== question.id) throw new Error('Invalid SPACE question');
    if (row.status === 'suppressed' && row.mean === null && !('answeredCount' in row))
      return { questionId: question.id, status: 'suppressed', mean: null };
    if (
      row.status === 'published' &&
      typeof row.mean === 'number' &&
      Number.isFinite(row.mean) &&
      row.mean >= 1 &&
      row.mean <= 5 &&
      typeof row.answeredCount === 'number' &&
      Number.isInteger(row.answeredCount) &&
      row.answeredCount >= threshold
    )
      return {
        questionId: question.id,
        status: 'published',
        mean: row.mean,
        answeredCount: row.answeredCount,
      };
    throw new Error('Invalid SPACE aggregate');
  });
}
async function stored(client: PoolClient, workspaceId: string, pulseId: string) {
  const result = await client.query<StoredPulse>(
    'SELECT * FROM space_pulses WHERE workspace_id=$1 AND id=$2',
    [workspaceId, uuid(pulseId)],
  );
  const row = result.rows[0];
  if (!row) throw new IdentityError(404, 'not_found');
  return row;
}
async function safePulse(
  client: PoolClient,
  actor: Actor,
  row: StoredPulse,
  owner: boolean,
): Promise<Pulse> {
  if (row.state === 'draft' && !owner) throw new IdentityError(404, 'not_found');
  const facts = await client.query<{ eligible: boolean; submitted: boolean; count: number }>(
    `SELECT EXISTS(SELECT 1 FROM space_roster WHERE pulse_id=$1 AND user_id=$2) AS eligible,
      EXISTS(SELECT 1 FROM space_receipts WHERE pulse_id=$1 AND user_id=$2) AS submitted,
      (SELECT count(*)::integer FROM space_receipts WHERE pulse_id=$1) AS count`,
    [row.id, actor.userId],
  );
  const own = facts.rows[0];
  if (!own) throw new Error('SPACE status missing');
  let teamName = row.team_name;
  let threshold = row.minimum_respondents;
  let rosterSize = row.roster_size;
  if (row.state === 'draft') {
    teamName = (await team(client, row.workspace_id, row.team_id)).name;
    threshold = await minimum(client, row.workspace_id);
    const roster = await client.query<{ count: number }>(
      'SELECT count(*)::integer AS count FROM space_assignments WHERE workspace_id=$1 AND team_id=$2',
      [row.workspace_id, row.team_id],
    );
    rosterSize = roster.rows[0]?.count ?? 0;
  }
  if (threshold === null || rosterSize === null) throw new Error('SPACE frozen context missing');
  const submittedCount =
    row.state === 'open' && owner
      ? own.count
      : row.state === 'closed' && (owner || (row.submitted_count ?? 0) >= threshold)
        ? row.submitted_count
        : null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    teamId: row.team_id,
    teamName,
    instrumentVersion: instrument.version,
    referenceStart: row.reference_start.toISOString(),
    referenceEnd: row.reference_end.toISOString(),
    state: row.state,
    minimumRespondents: threshold,
    rosterSize,
    openedAt: row.opened_at?.toISOString() ?? null,
    closedAt: row.closed_at?.toISOString() ?? null,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    eligible: row.state !== 'draft' && own.eligible,
    submitted: own.submitted,
    submittedCount,
    questions: row.state === 'closed' ? parseResults(row.questions, threshold) : null,
  };
}
export function createSpaceRepository(pool: Pool) {
  function scoped<T>(
    actor: Actor,
    workspaceId: string,
    owner: boolean,
    operation: (client: PoolClient) => Promise<T>,
  ) {
    return authorizedWorkspaceTransaction(pool, actor, uuid(workspaceId), owner, operation);
  }
  return {
    async instrument(actor: Actor, workspaceId: string) {
      return scoped(actor, workspaceId, false, async () => ({ instrument }));
    },
    async preferences(actor: Actor, workspaceId: string, body?: unknown) {
      const input =
        body === undefined
          ? null
          : parseMinimum(object(body, ['minimumRespondents']).minimumRespondents);
      return scoped(actor, workspaceId, input !== null, async (client) => {
        if (input !== null)
          await client.query(
            'INSERT INTO space_preferences(workspace_id,minimum_respondents) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET minimum_respondents=EXCLUDED.minimum_respondents',
            [workspaceId, input],
          );
        return { workspaceId, minimumRespondents: await minimum(client, workspaceId) };
      });
    },
    async assignments(actor: Actor, workspaceId: string, query: unknown) {
      const input = object(query, ['cursor']);
      const cursor = input.cursor === undefined ? null : opaqueId(input.cursor);
      return scoped(actor, workspaceId, true, async (client) => {
        if (cursor !== null) {
          const found = await client.query(
            'SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
            [workspaceId, cursor],
          );
          if (!found.rowCount) throw new IdentityError(404, 'not_found');
        }
        const result = await client.query<AssignmentRow>(
          `SELECT m.user_id AS "userId",a.team_id AS "teamId",t.name AS "teamName"
          FROM workspace_memberships m LEFT JOIN space_assignments a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id
          LEFT JOIN teams t ON t.workspace_id=a.workspace_id AND t.id=a.team_id
          WHERE m.workspace_id=$1 AND ($2::text IS NULL OR m.user_id>$2) ORDER BY m.user_id LIMIT 101`,
          [workspaceId, cursor],
        );
        return {
          workspaceId,
          assignments: result.rows.slice(0, 100),
          nextCursor: result.rows.length > 100 ? (result.rows[99]?.userId ?? null) : null,
        };
      });
    },
    async assign(actor: Actor, workspaceId: string, userId: string, body: unknown) {
      const target = opaqueId(userId);
      const input = object(body, ['teamId']);
      const teamId = input.teamId === null ? null : uuid(input.teamId);
      return scoped(actor, workspaceId, true, async (client) => {
        const found = await client.query(
          'SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2',
          [workspaceId, target],
        );
        if (!found.rowCount) throw new IdentityError(404, 'not_found');
        const teamName = teamId === null ? null : (await team(client, workspaceId, teamId)).name;
        await client.query(
          'INSERT INTO space_assignments(workspace_id,user_id,team_id) VALUES($1,$2,$3) ON CONFLICT(workspace_id,user_id) DO UPDATE SET team_id=EXCLUDED.team_id',
          [workspaceId, target, teamId],
        );
        return { workspaceId, assignment: { userId: target, teamId, teamName } };
      });
    },
    async ownAssignment(actor: Actor, workspaceId: string, query: unknown) {
      const input = object(query, ['cursor']);
      const cursor = input.cursor === undefined ? null : uuid(input.cursor);
      return scoped(actor, workspaceId, false, async (client) => {
        if (cursor !== null) {
          const found = await client.query(
            'SELECT 1 FROM space_assignment_history WHERE workspace_id=$1 AND user_id=$2 AND id=$3',
            [workspaceId, actor.userId, cursor],
          );
          if (!found.rowCount) throw new IdentityError(404, 'not_found');
        }
        const current = await client.query<{ teamId: string | null; teamName: string | null }>(
          `SELECT a.team_id AS "teamId",t.name AS "teamName" FROM space_assignments a LEFT JOIN teams t ON t.workspace_id=a.workspace_id AND t.id=a.team_id WHERE a.workspace_id=$1 AND a.user_id=$2`,
          [workspaceId, actor.userId],
        );
        const history = await client.query<HistoryRow>(
          `SELECT id,team_id AS "teamId",team_name AS "teamName",changed_at AS "changedAt" FROM space_assignment_history
          WHERE workspace_id=$1 AND user_id=$2 AND ($3::uuid IS NULL OR (changed_at,id)<(SELECT changed_at,id FROM space_assignment_history WHERE id=$3 AND workspace_id=$1 AND user_id=$2))
          ORDER BY changed_at DESC,id DESC LIMIT 26`,
          [workspaceId, actor.userId, cursor],
        );
        return {
          workspaceId,
          teamId: current.rows[0]?.teamId ?? null,
          teamName: current.rows[0]?.teamName ?? null,
          history: history.rows
            .slice(0, 25)
            .map((row) => ({ ...row, changedAt: row.changedAt.toISOString() })),
          nextCursor: history.rows.length > 25 ? (history.rows[24]?.id ?? null) : null,
        };
      });
    },
    async create(actor: Actor, workspaceId: string, body: unknown) {
      const input = parseDraft(body);
      return scoped(actor, workspaceId, true, async (client) => {
        const parent = await team(client, workspaceId, input.teamId);
        const id = randomUUID();
        await client.query(
          `INSERT INTO space_pulses(id,workspace_id,team_id,current_team_id,team_name,instrument_version,reference_start,reference_end) VALUES($1,$2,$3,$3,$4,$5,$6,$7)`,
          [
            id,
            workspaceId,
            input.teamId,
            parent.name,
            instrument.version,
            input.referenceStart,
            input.referenceEnd,
          ],
        );
        return safePulse(client, actor, await stored(client, workspaceId, id), true);
      });
    },
    async update(actor: Actor, workspaceId: string, pulseId: string, body: unknown) {
      const input = parseDraft(body);
      return scoped(actor, workspaceId, true, async (client) => {
        const row = await stored(client, workspaceId, pulseId);
        if (row.state !== 'draft') throw new IdentityError(409, 'conflict');
        const parent = await team(client, workspaceId, input.teamId);
        await client.query(
          'UPDATE space_pulses SET team_id=$3,current_team_id=$3,team_name=$4,reference_start=$5,reference_end=$6 WHERE workspace_id=$1 AND id=$2',
          [
            workspaceId,
            row.id,
            input.teamId,
            parent.name,
            input.referenceStart,
            input.referenceEnd,
          ],
        );
        return safePulse(client, actor, await stored(client, workspaceId, row.id), true);
      });
    },
    async get(actor: Actor, workspaceId: string, pulseId: string) {
      return scoped(actor, workspaceId, false, async (client) =>
        safePulse(
          client,
          actor,
          await stored(client, workspaceId, pulseId),
          await ownerRole(client, actor, workspaceId),
        ),
      );
    },
    async list(actor: Actor, workspaceId: string, query: unknown) {
      const input = object(query, ['cursor', 'teamId']);
      const cursor = input.cursor === undefined ? null : uuid(input.cursor);
      const teamId = input.teamId === undefined ? null : uuid(input.teamId);
      return scoped(actor, workspaceId, false, async (client) => {
        const owner = await ownerRole(client, actor, workspaceId);
        if (cursor !== null) {
          const found = await client.query(
            `SELECT 1 FROM space_pulses WHERE workspace_id=$1 AND id=$2 AND ($3::uuid IS NULL OR team_id=$3) AND ($4::boolean OR state<>'draft')`,
            [workspaceId, cursor, teamId, owner],
          );
          if (!found.rowCount) throw new IdentityError(404, 'not_found');
        }
        const result = await client.query<StoredPulse>(
          `SELECT * FROM space_pulses WHERE workspace_id=$1 AND ($2::uuid IS NULL OR team_id=$2) AND ($3::boolean OR state<>'draft')
          AND ($4::uuid IS NULL OR (created_at,id)<(SELECT created_at,id FROM space_pulses WHERE workspace_id=$1 AND id=$4)) ORDER BY created_at DESC,id DESC LIMIT 26`,
          [workspaceId, teamId, owner, cursor],
        );
        const pulses: Pulse[] = [];
        for (const row of result.rows.slice(0, 25))
          pulses.push(await safePulse(client, actor, row, owner));
        return {
          workspaceId,
          pulses,
          nextCursor: result.rows.length > 25 ? (result.rows[24]?.id ?? null) : null,
        };
      });
    },
    async transition(
      actor: Actor,
      workspaceId: string,
      pulseId: string,
      action: 'open' | 'close' | 'cancel',
    ) {
      return scoped(actor, workspaceId, true, async (client) => {
        const row = await stored(client, workspaceId, pulseId);
        if (
          (action === 'close' && row.state === 'closed') ||
          (action === 'cancel' && row.state === 'cancelled')
        )
          return safePulse(client, actor, row, true);
        if (action === 'open') {
          if (row.state !== 'draft') throw new IdentityError(409, 'conflict');
          const parent = await team(client, workspaceId, row.team_id);
          const roster = await client.query<{ user_id: string }>(
            'SELECT a.user_id FROM space_assignments a JOIN workspace_memberships m ON m.workspace_id=a.workspace_id AND m.user_id=a.user_id WHERE a.workspace_id=$1 AND a.team_id=$2 ORDER BY a.user_id',
            [workspaceId, row.team_id],
          );
          if (!roster.rows.length) throw new IdentityError(409, 'conflict');
          const conflict = await client.query(
            `SELECT 1 FROM space_pulses p WHERE p.workspace_id=$1 AND p.id<>$2 AND
            ((p.team_id=$3 AND p.state='open') OR (p.state IN ('open','closed') AND p.reference_start<$5 AND p.reference_end>$4 AND EXISTS
              (SELECT 1 FROM space_roster r WHERE r.pulse_id=p.id AND r.user_id=ANY($6::text[])))) LIMIT 1`,
            [
              workspaceId,
              row.id,
              row.team_id,
              row.reference_start,
              row.reference_end,
              roster.rows.map((r) => r.user_id),
            ],
          );
          if (conflict.rowCount) throw new IdentityError(409, 'conflict');
          await client.query(
            `UPDATE space_pulses SET state='open',team_name=$3,minimum_respondents=$4,roster_size=$5,opened_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2`,
            [
              workspaceId,
              row.id,
              parent.name,
              await minimum(client, workspaceId),
              roster.rows.length,
            ],
          );
          await client.query(
            'INSERT INTO space_roster(pulse_id,user_id) SELECT $1,unnest($2::text[])',
            [row.id, roster.rows.map((r) => r.user_id)],
          );
          // Same transaction: pulse opening and its frozen notification policy/invitations commit together.
          await capturePulseNotifications(client, workspaceId, row.id);
        } else if (action === 'close') {
          if (row.state !== 'open' || row.minimum_respondents === null)
            throw new IdentityError(409, 'conflict');
          const answers = await client.query<{ answers: unknown }>(
            'SELECT answers FROM space_answers WHERE pulse_id=$1',
            [row.id],
          );
          const questions = aggregateResponses(
            answers.rows.map((r) => parseAnswers(r.answers)),
            row.minimum_respondents,
          );
          await client.query(
            `UPDATE space_pulses SET state='closed',closed_at=clock_timestamp(),questions=$3::jsonb,submitted_count=(SELECT count(*)::integer FROM space_receipts WHERE pulse_id=$2) WHERE workspace_id=$1 AND id=$2`,
            [workspaceId, row.id, JSON.stringify(questions)],
          );
          await client.query('DELETE FROM space_answers WHERE pulse_id=$1', [row.id]);
          await closePulseNotifications(client, workspaceId, row.id);
        } else {
          if (row.state !== 'draft' && row.state !== 'open')
            throw new IdentityError(409, 'conflict');
          const preview = await safePulse(client, actor, row, true);
          await client.query(
            `UPDATE space_pulses SET state='cancelled',cancelled_at=clock_timestamp(),team_name=$3,minimum_respondents=$4,roster_size=$5 WHERE workspace_id=$1 AND id=$2`,
            [workspaceId, row.id, preview.teamName, preview.minimumRespondents, preview.rosterSize],
          );
          await client.query('DELETE FROM space_answers WHERE pulse_id=$1', [row.id]);
          await cancelPulseNotifications(client, workspaceId, row.id);
        }
        return safePulse(client, actor, await stored(client, workspaceId, row.id), true);
      });
    },
    async submit(actor: Actor, workspaceId: string, pulseId: string, body: unknown) {
      const answers = parseResponse(body);
      return scoped(actor, workspaceId, false, async (client) => {
        const row = await stored(client, workspaceId, pulseId);
        if (row.state === 'draft') throw new IdentityError(404, 'not_found');
        const eligible = await client.query(
          'SELECT 1 FROM space_roster WHERE pulse_id=$1 AND user_id=$2',
          [row.id, actor.userId],
        );
        if (!eligible.rowCount) throw new IdentityError(403, 'forbidden');
        const receipt = await client.query(
          'SELECT 1 FROM space_receipts WHERE pulse_id=$1 AND user_id=$2',
          [row.id, actor.userId],
        );
        if (!receipt.rowCount) {
          if (row.state !== 'open') throw new IdentityError(409, 'conflict');
          await client.query('INSERT INTO space_receipts(pulse_id,user_id) VALUES($1,$2)', [
            row.id,
            actor.userId,
          ]);
          await client.query(
            'INSERT INTO space_answers(id,pulse_id,answers) VALUES($1,$2,$3::jsonb)',
            [randomUUID(), row.id, JSON.stringify(answers)],
          );
        }
        // Accepted and replayed responses both stop pending invitations/reminders for this member.
        // Only the receipt fact is used; notifications never join respondents to answers.
        await suppressMemberNotifications(client, workspaceId, actor.userId, row.id);
        return { workspaceId, pulseId: row.id, submitted: true as const };
      });
    },
  };
}
