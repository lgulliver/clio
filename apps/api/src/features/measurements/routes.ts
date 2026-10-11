import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { object, uuid } from '../identity/input.ts';
import type { Actor } from '../identity/repository.ts';
import { createMeasurementRepository } from './repository.ts';
import { type MeasurementDependencies, provider } from './source-eligibility.ts';
/** Register inside protected identity plugin, retaining its error/no-store/Origin hooks. */
export function registerMeasurementRoutes(
  routes: FastifyInstance,
  dependencies: MeasurementDependencies & {
    pool: Pool;
    actor: (request: FastifyRequest, reply: FastifyReply, write: boolean) => Promise<Actor>;
  },
) {
  const repository = createMeasurementRepository(dependencies.pool, dependencies),
    base = '/api/workspaces/:workspaceId/services/:serviceId';
  async function scope(request: FastifyRequest, reply: FastifyReply, write: boolean) {
    const actor = await dependencies.actor(request, reply, write),
      row = object(request.params, ['workspaceId', 'serviceId', 'runId']);
    return {
      actor,
      workspaceId: uuid(row.workspaceId),
      serviceId: uuid(row.serviceId),
      runId: row.runId,
    };
  }
  routes.post(`${base}/measurement-runs`, async (request, reply) => {
    const s = await scope(request, reply, true);
    return reply
      .code(202)
      .send({ run: await repository.enqueue(s.actor, s.workspaceId, s.serviceId, request.body) });
  });
  routes.get(`${base}/measurement-runs`, async (request, reply) => {
    const s = await scope(request, reply, false),
      query = object(request.query, ['cursor', 'status']);
    return repository.list(s.actor, s.workspaceId, s.serviceId, query.cursor, query.status);
  });
  routes.get(`${base}/measurement-runs/:runId`, async (request, reply) => {
    const s = await scope(request, reply, false);
    return { run: await repository.getRun(s.actor, s.workspaceId, s.serviceId, uuid(s.runId)) };
  });
  routes.get(`${base}/measurement-authorities`, async (request, reply) => {
    const s = await scope(request, reply, false),
      query = object(request.query, ['provider', 'basisRunId']);
    return repository.authorities(
      s.actor,
      s.workspaceId,
      s.serviceId,
      provider(query.provider),
      uuid(query.basisRunId),
    );
  });
}
