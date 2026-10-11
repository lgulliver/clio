import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { object, uuid } from '../identity/input.ts';
import type { Actor } from '../identity/repository.ts';
import type { ArgoConfig } from './config.ts';
import { createArgoRepository } from './repository.ts';

/** Register inside the identity plugin: its error handler/no-store hooks redact dependencies. */
export function registerArgoRoutes(
  routes: FastifyInstance,
  dependencies: {
    pool: Pool;
    argo: ArgoConfig | null;
    actor: (request: FastifyRequest, reply: FastifyReply, write: boolean) => Promise<Actor>;
  },
) {
  const repository = createArgoRepository(dependencies.pool, dependencies.argo);
  const base = '/api/workspaces/:workspaceId/services/:serviceId';
  async function scope(request: FastifyRequest, reply: FastifyReply, write: boolean) {
    const actor = await dependencies.actor(request, reply, write);
    const row = object(request.params, ['workspaceId', 'serviceId', 'runId']);
    return {
      actor,
      workspaceId: uuid(row.workspaceId),
      serviceId: uuid(row.serviceId),
      runId: row.runId,
    };
  }
  routes.get(`${base}/argo-connection`, async (request, reply) => {
    const s = await scope(request, reply, false);
    return repository.get(s.actor, s.workspaceId, s.serviceId);
  });
  routes.post(`${base}/argo-connection`, async (request, reply) => {
    const s = await scope(request, reply, true);
    return { connection: await repository.save(s.actor, s.workspaceId, s.serviceId, request.body) };
  });
  routes.post(`${base}/argo-connection/disconnect`, async (request, reply) => {
    const s = await scope(request, reply, true);
    return {
      connection: await repository.disconnect(s.actor, s.workspaceId, s.serviceId, request.body),
    };
  });
  routes.post(`${base}/argo-collection-runs`, async (request, reply) => {
    const s = await scope(request, reply, true);
    return reply
      .code(202)
      .send({ run: await repository.enqueue(s.actor, s.workspaceId, s.serviceId, request.body) });
  });
  routes.get(`${base}/argo-collection-runs`, async (request, reply) => {
    const s = await scope(request, reply, false);
    return repository.listPage(s.actor, s.workspaceId, s.serviceId, request.query);
  });
  routes.get(`${base}/argo-collection-runs/:runId`, async (request, reply) => {
    const s = await scope(request, reply, false);
    return { run: await repository.getRun(s.actor, s.workspaceId, s.serviceId, uuid(s.runId)) };
  });
}
