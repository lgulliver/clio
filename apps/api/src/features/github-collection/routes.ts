import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { object, uuid } from '../identity/input.ts';
import type { Actor } from '../identity/repository.ts';
import type { GitHubConfig } from './config.ts';
import { createGitHubRepository } from './repository.ts';

/** Register inside the identity plugin: its error handler/no-store hooks redact dependencies. */
export function registerGitHubRoutes(
  routes: FastifyInstance,
  dependencies: {
    pool: Pool;
    github: GitHubConfig | null;
    actor: (request: FastifyRequest, reply: FastifyReply, write: boolean) => Promise<Actor>;
  },
) {
  const repository = createGitHubRepository(dependencies.pool, dependencies.github);
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
  routes.get(`${base}/github-connection`, async (request, reply) => {
    const s = await scope(request, reply, false);
    return repository.get(s.actor, s.workspaceId, s.serviceId);
  });
  routes.post(`${base}/github-connection`, async (request, reply) => {
    const s = await scope(request, reply, true);
    return { connection: await repository.save(s.actor, s.workspaceId, s.serviceId, request.body) };
  });
  routes.post(`${base}/github-connection/disconnect`, async (request, reply) => {
    const s = await scope(request, reply, true);
    return {
      connection: await repository.disconnect(s.actor, s.workspaceId, s.serviceId, request.body),
    };
  });
  routes.post(`${base}/github-collection-runs`, async (request, reply) => {
    const s = await scope(request, reply, true);
    return reply
      .code(202)
      .send({ run: await repository.enqueue(s.actor, s.workspaceId, s.serviceId, request.body) });
  });
  routes.get(`${base}/github-collection-runs`, async (request, reply) => {
    const s = await scope(request, reply, false);
    return { runs: await repository.list(s.actor, s.workspaceId, s.serviceId) };
  });
  routes.get(`${base}/github-collection-runs/:runId`, async (request, reply) => {
    const s = await scope(request, reply, false);
    return { run: await repository.getRun(s.actor, s.workspaceId, s.serviceId, uuid(s.runId)) };
  });
}
