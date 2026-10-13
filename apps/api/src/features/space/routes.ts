import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { IdentityError, object, opaqueId, uuid } from '../identity/input.ts';
import type { Actor } from '../identity/repository.ts';
import { createSpaceRepository } from './repository.ts';

interface Dependencies {
  pool: Pool;
  actor: (request: FastifyRequest, reply: FastifyReply, write: boolean) => Promise<Actor>;
}
export function registerSpaceRoutes(server: FastifyInstance, dependencies?: Dependencies) {
  const repository = dependencies ? createSpaceRepository(dependencies.pool) : null;
  const base = '/api/workspaces/:workspaceId/space';
  async function context(
    request: FastifyRequest,
    reply: FastifyReply,
    write: boolean,
    extra: string[] = [],
  ) {
    if (!dependencies || !repository) throw new IdentityError(503, 'unavailable');
    const actor = await dependencies.actor(request, reply, write);
    const params = object(request.params, ['workspaceId', ...extra]);
    return { actor, workspaceId: uuid(params.workspaceId), params };
  }
  server.get(`${base}/instrument`, async (request, reply) => {
    const c = await context(request, reply, false);
    object(request.query, []);
    if (!repository) throw new IdentityError(503, 'unavailable');
    return repository.instrument(c.actor, c.workspaceId);
  });
  server.get(`${base}/preferences`, async (request, reply) => {
    const c = await context(request, reply, false);
    object(request.query, []);
    if (!repository) throw new IdentityError(503, 'unavailable');
    return repository.preferences(c.actor, c.workspaceId);
  });
  server.patch(`${base}/preferences`, async (request, reply) => {
    const c = await context(request, reply, true);
    object(request.query, []);
    if (!repository) throw new IdentityError(503, 'unavailable');
    return repository.preferences(c.actor, c.workspaceId, request.body ?? null);
  });
  server.get(`${base}/assignments`, async (request, reply) => {
    const c = await context(request, reply, false);
    if (!repository) throw new IdentityError(503, 'unavailable');
    return repository.assignments(c.actor, c.workspaceId, request.query);
  });
  server.post(`${base}/assignments/:userId`, async (request, reply) => {
    const c = await context(request, reply, true, ['userId']);
    object(request.query, []);
    if (!repository) throw new IdentityError(503, 'unavailable');
    return repository.assign(c.actor, c.workspaceId, opaqueId(c.params.userId), request.body);
  });
  server.get(`${base}/assignment`, async (request, reply) => {
    const c = await context(request, reply, false);
    if (!repository) throw new IdentityError(503, 'unavailable');
    return repository.ownAssignment(c.actor, c.workspaceId, request.query);
  });
  server.get(`${base}/pulses`, async (request, reply) => {
    const c = await context(request, reply, false);
    if (!repository) throw new IdentityError(503, 'unavailable');
    return repository.list(c.actor, c.workspaceId, request.query);
  });
  server.post(`${base}/pulses`, async (request, reply) => {
    const c = await context(request, reply, true);
    object(request.query, []);
    if (!repository) throw new IdentityError(503, 'unavailable');
    return reply
      .code(201)
      .send({ pulse: await repository.create(c.actor, c.workspaceId, request.body) });
  });
  server.get(`${base}/pulses/:pulseId`, async (request, reply) => {
    const c = await context(request, reply, false, ['pulseId']);
    object(request.query, []);
    if (!repository) throw new IdentityError(503, 'unavailable');
    return { pulse: await repository.get(c.actor, c.workspaceId, uuid(c.params.pulseId)) };
  });
  server.patch(`${base}/pulses/:pulseId`, async (request, reply) => {
    const c = await context(request, reply, true, ['pulseId']);
    object(request.query, []);
    if (!repository) throw new IdentityError(503, 'unavailable');
    return {
      pulse: await repository.update(c.actor, c.workspaceId, uuid(c.params.pulseId), request.body),
    };
  });
  for (const action of ['open', 'close', 'cancel'] as const) {
    server.post(`${base}/pulses/:pulseId/${action}`, async (request, reply) => {
      const c = await context(request, reply, true, ['pulseId']);
      object(request.query, []);
      object(request.body, []);
      if (!repository) throw new IdentityError(503, 'unavailable');
      return {
        pulse: await repository.transition(c.actor, c.workspaceId, uuid(c.params.pulseId), action),
      };
    });
  }
  server.post(`${base}/pulses/:pulseId/response`, async (request, reply) => {
    const c = await context(request, reply, true, ['pulseId']);
    object(request.query, []);
    if (!repository) throw new IdentityError(503, 'unavailable');
    return repository.submit(c.actor, c.workspaceId, uuid(c.params.pulseId), request.body);
  });
}
