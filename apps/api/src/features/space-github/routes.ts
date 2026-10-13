import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { IdentityError, object, uuid } from '../identity/input.ts';
import type { Actor } from '../identity/repository.ts';
import type { SpaceGitHubConfig } from './config.ts';
import {
  parseCollectionRequest,
  parseDisconnectRequest,
  parseMappingRequest,
  parseMappingUpdateRequest,
  parsePageQuery,
} from './input.ts';
import type { SpaceGitHubProvider } from './provider.ts';
import { createSpaceGitHubRepository } from './repository.ts';

interface Dependencies {
  pool: Pool;
  config: SpaceGitHubConfig | null;
  actor: (request: FastifyRequest, reply: FastifyReply, write: boolean) => Promise<Actor>;
  provider?: SpaceGitHubProvider;
}

/** Register inside the identity plugin, which owns no-store and session/Origin handling. */
export function registerSpaceGitHubRoutes(server: FastifyInstance, dependencies?: Dependencies) {
  const repository = dependencies
    ? createSpaceGitHubRepository(dependencies.pool, dependencies.config, {
        ...(dependencies.provider ? { provider: dependencies.provider } : {}),
      })
    : null;
  const base = '/api/workspaces/:workspaceId/space/github';
  async function context(
    request: FastifyRequest,
    reply: FastifyReply,
    write: boolean,
    extra: readonly string[] = [],
  ) {
    if (!dependencies || !repository) throw new IdentityError(503, 'unavailable');
    const actor = await dependencies.actor(request, reply, write);
    const params = object(request.params, ['workspaceId', ...extra]);
    return { actor, workspaceId: uuid(params.workspaceId), params, repository };
  }
  async function safe<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error.code === '23505' || error.code === '23503')
      )
        throw new IdentityError(409, 'conflict');
      throw new IdentityError(503, 'unavailable');
    }
  }
  server.get(`${base}/availability`, async (request, reply) => {
    const c = await context(request, reply, false);
    object(request.query, []);
    return safe(() => c.repository.availability(c.actor, c.workspaceId));
  });
  server.get(`${base}/mappings`, async (request, reply) => {
    const c = await context(request, reply, false);
    const query = parsePageQuery(request.query);
    return safe(() => c.repository.list(c.actor, c.workspaceId, query));
  });
  server.post(`${base}/mappings`, async (request, reply) => {
    const c = await context(request, reply, true);
    object(request.query, []);
    const body = parseMappingRequest(request.body);
    return reply.code(201).send({
      mapping: await safe(() => c.repository.save(c.actor, c.workspaceId, body)),
    });
  });
  server.patch(`${base}/mappings/:mappingId`, async (request, reply) => {
    const c = await context(request, reply, true, ['mappingId']);
    object(request.query, []);
    const mappingId = uuid(c.params.mappingId);
    const body = parseMappingUpdateRequest(request.body);
    return {
      mapping: await safe(() => c.repository.update(c.actor, c.workspaceId, mappingId, body)),
    };
  });
  server.post(`${base}/mappings/:mappingId/disconnect`, async (request, reply) => {
    const c = await context(request, reply, true, ['mappingId']);
    object(request.query, []);
    const mappingId = uuid(c.params.mappingId);
    const body = parseDisconnectRequest(request.body);
    return {
      mapping: await safe(() => c.repository.disconnect(c.actor, c.workspaceId, mappingId, body)),
    };
  });
  server.post(`${base}/mappings/:mappingId/runs`, async (request, reply) => {
    const c = await context(request, reply, true, ['mappingId']);
    object(request.query, []);
    const mappingId = uuid(c.params.mappingId);
    const body = parseCollectionRequest(request.body);
    return reply.code(202).send({
      run: await safe(() => c.repository.enqueue(c.actor, c.workspaceId, mappingId, body)),
    });
  });
  server.get(`${base}/mappings/:mappingId/runs`, async (request, reply) => {
    const c = await context(request, reply, false, ['mappingId']);
    const mappingId = uuid(c.params.mappingId);
    const query = parsePageQuery(request.query);
    return safe(() => c.repository.history(c.actor, c.workspaceId, mappingId, query));
  });
  server.get(`${base}/mappings/:mappingId/results`, async (request, reply) => {
    const c = await context(request, reply, false, ['mappingId']);
    const mappingId = uuid(c.params.mappingId);
    const query = parsePageQuery(request.query);
    return safe(() => c.repository.results(c.actor, c.workspaceId, mappingId, query));
  });
  server.get(`${base}/results/:resultId`, async (request, reply) => {
    const c = await context(request, reply, false, ['resultId']);
    object(request.query, []);
    const resultId = uuid(c.params.resultId);
    return { result: await safe(() => c.repository.getResult(c.actor, c.workspaceId, resultId)) };
  });
}
