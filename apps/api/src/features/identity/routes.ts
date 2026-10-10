import cors from '@fastify/cors';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { revision } from '../deployment-mappings/input.ts';
import { previewMapping } from '../deployment-mappings/preview.ts';
import { createMappingRepository } from '../deployment-mappings/repository.ts';
import { createMockCollectionRepository } from '../mock-collection/repository.ts';
import { type ClioAuth, readSession } from './auth.ts';
import type { AuthConfig } from './config.ts';
import { IdentityError, object, opaqueId, uuid } from './input.ts';
import { type Actor, createIdentityRepository } from './repository.ts';

export interface IdentityDependencies {
  auth: ClioAuth;
  config: AuthConfig;
  pool: Pool;
}

function clientError(status: number) {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  return 'invalid_request';
}

function safeUser(user: {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image?: string | null | undefined;
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    image: user.image ?? null,
  };
}

export function registerIdentity(server: FastifyInstance, identity?: IdentityDependencies) {
  if (identity)
    server.register(cors, {
      origin: identity.config.appOrigin,
      credentials: true,
      methods: ['GET', 'POST', 'DELETE'],
      allowedHeaders: ['Content-Type'],
    });
  const repository = identity ? createIdentityRepository(identity.pool) : null;
  const mappings = identity ? createMappingRepository(identity.pool) : null;
  const runs = identity ? createMockCollectionRepository(identity.pool) : null;
  async function session(request: FastifyRequest, reply: FastifyReply, write: boolean) {
    if (!identity || !repository) throw new IdentityError(503, 'unavailable');
    if (write && request.headers.origin !== identity.config.appOrigin)
      throw new IdentityError(403, 'forbidden');
    const result = await readSession(identity.auth, fromNodeHeaders(request.headers));
    const cookies = result.headers.getSetCookie();
    if (cookies.length) reply.header('set-cookie', cookies);
    const current = result.response;
    if (!current) throw new IdentityError(401, 'unauthorized');
    return current;
  }
  async function actor(
    request: FastifyRequest,
    reply: FastifyReply,
    write: boolean,
  ): Promise<Actor> {
    const current = await session(request, reply, write);
    return { userId: current.user.id, sessionId: current.session.id };
  }
  function params(request: FastifyRequest, keys: string[]) {
    return object(request.params, keys);
  }
  // Scoped plugin error handling also redacts SQL/auth failures and token-bearing inputs.
  server.register(async (routes) => {
    routes.addHook('onSend', async (_request, reply, payload) => {
      reply.header('cache-control', 'no-store');
      return payload;
    });
    routes.setErrorHandler((error, request, reply) => {
      if (
        identity &&
        new URL(request.url, identity.config.baseUrl).pathname === '/api/auth/callback/github'
      )
        return reply.redirect(
          new URL('/settings?authError=1', identity.config.appOrigin).href,
          303,
        );
      if (error instanceof IdentityError)
        return reply.code(error.status).send({ error: error.message });
      if (
        typeof error === 'object' &&
        error !== null &&
        'statusCode' in error &&
        typeof error.statusCode === 'number' &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      )
        return reply.code(error.statusCode).send({ error: clientError(error.statusCode) });
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
        return reply.code(409).send({ error: 'conflict' });
      return reply.code(503).send({ error: 'unavailable' });
    });
    routes.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      async handler(request, reply) {
        if (!identity) throw new IdentityError(503, 'unavailable');
        // Never derive callback URLs from untrusted Host/forwarded headers.
        const url = new URL(identity.config.baseUrl);
        const incoming = new URL(request.url, identity.config.baseUrl);
        url.pathname = incoming.pathname;
        url.search = incoming.search;
        const path = url.pathname.slice('/api/auth'.length);
        const allowed =
          request.method === 'GET'
            ? ['/callback/github', '/error']
            : ['/sign-in/social', '/sign-out'];
        if (!allowed.includes(path)) throw new IdentityError(404, 'not_found');
        if (request.method === 'POST' && request.headers.origin !== identity.config.appOrigin)
          throw new IdentityError(403, 'forbidden');
        if (path === '/error')
          return reply.redirect(
            new URL('/settings?authError=1', identity.config.appOrigin).href,
            303,
          );
        let body: unknown = request.body ?? {};
        if (path === '/sign-in/social') {
          const parsed = object(request.body, ['provider', 'callbackURL', 'disableRedirect']);
          if (
            parsed.provider !== 'github' ||
            (parsed.callbackURL !== undefined && typeof parsed.callbackURL !== 'string') ||
            (parsed.disableRedirect !== undefined && typeof parsed.disableRedirect !== 'boolean')
          )
            throw new IdentityError(400, 'invalid_request');
          body = { ...parsed, callbackURL: parsed.callbackURL ?? identity.config.appOrigin };
        }
        if (path === '/sign-out') object(request.body ?? {}, []);
        const authHeaders = fromNodeHeaders(request.headers);
        // Fastify trusts the direct socket only. Never trust client-supplied IP
        // headers for Better Auth session tracking or production rate limits.
        authHeaders.set('x-clio-client-ip', request.ip);
        const response = await identity.auth.handler(
          new Request(url, {
            method: request.method,
            headers: authHeaders,
            ...(request.method === 'POST' ? { body: JSON.stringify(body) } : {}),
          }),
        );
        if (path === '/sign-out' && response.ok) {
          // Better Auth 1.7.7 swallows deletion errors. Verify database revocation
          // rather than reporting successful logout with an active session.
          const remaining = await identity.auth.api.getSession({
            headers: fromNodeHeaders(request.headers),
            query: { disableCookieCache: true },
          });
          if (remaining) throw new IdentityError(503, 'unavailable');
        }
        // Library errors can contain schema/provider details; keep failures redacted.
        if (response.status >= 500) throw new IdentityError(503, 'unavailable');
        reply.code(response.status);
        response.headers.forEach((value, key) => {
          if (key !== 'set-cookie' && key !== 'content-length') reply.header(key, value);
        });
        const cookies = response.headers.getSetCookie();
        if (cookies.length) reply.header('set-cookie', cookies);
        reply.header('cache-control', 'no-store');
        if (response.status >= 400)
          return reply.type('application/json').send({ error: clientError(response.status) });
        return reply.send(response.body ? await response.text() : null);
      },
    });
    routes.get('/api/me', async (request, reply) => {
      const current = await session(request, reply, false);
      reply.header('cache-control', 'no-store');
      return { user: safeUser(current.user) };
    });
    routes.get('/api/workspaces', async (request, reply) => {
      const current = await actor(request, reply, false);
      if (!repository) throw new IdentityError(503, 'unavailable');
      reply.header('cache-control', 'no-store');
      return { workspaces: await repository.listWorkspaces(current) };
    });
    routes.post('/api/workspaces', async (request, reply) => {
      const current = await actor(request, reply, true);
      const body = object(request.body, ['name']);
      if (!repository) throw new IdentityError(503, 'unavailable');
      return reply
        .code(201)
        .send({ workspace: await repository.createWorkspace(current, body.name) });
    });
    routes.get('/api/workspaces/:workspaceId/services', async (request, reply) => {
      const current = await actor(request, reply, false);
      const id = uuid(params(request, ['workspaceId']).workspaceId);
      if (!repository) throw new IdentityError(503, 'unavailable');
      reply.header('cache-control', 'no-store');
      return { services: await repository.listServices(current, id) };
    });
    routes.post('/api/workspaces/:workspaceId/services', async (request, reply) => {
      const current = await actor(request, reply, true);
      const id = uuid(params(request, ['workspaceId']).workspaceId);
      const body = object(request.body, ['name']);
      if (!repository) throw new IdentityError(503, 'unavailable');
      return reply
        .code(201)
        .send({ service: await repository.createService(current, id, body.name) });
    });
    const mappingBase = '/api/workspaces/:workspaceId/services/:serviceId';
    routes.get(`${mappingBase}/deployment-mapping`, async (request, reply) => {
      const current = await actor(request, reply, false);
      const values = params(request, ['workspaceId', 'serviceId']);
      if (!mappings) throw new IdentityError(503, 'unavailable');
      return {
        mapping: await mappings.get(current, uuid(values.workspaceId), uuid(values.serviceId)),
      };
    });
    routes.post(`${mappingBase}/deployment-mapping`, async (request, reply) => {
      const current = await actor(request, reply, true);
      const values = params(request, ['workspaceId', 'serviceId']);
      if (!mappings) throw new IdentityError(503, 'unavailable');
      return {
        mapping: await mappings.save(
          current,
          uuid(values.workspaceId),
          uuid(values.serviceId),
          request.body,
        ),
      };
    });
    const runsBase = `${mappingBase}/mock-collection-runs`;
    routes.post(runsBase, async (request, reply) => {
      const current = await actor(request, reply, true);
      const values = params(request, ['workspaceId', 'serviceId']);
      if (!runs) throw new IdentityError(503, 'unavailable');
      return reply.code(202).send({
        run: await runs.enqueue(
          current,
          uuid(values.workspaceId),
          uuid(values.serviceId),
          request.body,
        ),
      });
    });
    routes.get(runsBase, async (request, reply) => {
      const current = await actor(request, reply, false);
      const values = params(request, ['workspaceId', 'serviceId']);
      if (!runs) throw new IdentityError(503, 'unavailable');
      return { runs: await runs.list(current, uuid(values.workspaceId), uuid(values.serviceId)) };
    });
    routes.get(`${runsBase}/:runId`, async (request, reply) => {
      const current = await actor(request, reply, false);
      const values = params(request, ['workspaceId', 'serviceId', 'runId']);
      if (!runs) throw new IdentityError(503, 'unavailable');
      return {
        run: await runs.get(
          current,
          uuid(values.workspaceId),
          uuid(values.serviceId),
          uuid(values.runId),
        ),
      };
    });
    routes.post(`${mappingBase}/deployment-preview`, async (request, reply) => {
      const current = await actor(request, reply, true);
      const values = params(request, ['workspaceId', 'serviceId']);
      const body = object(request.body, ['revision']);
      if (!mappings) throw new IdentityError(503, 'unavailable');
      const input = await mappings.previewInput(
        current,
        uuid(values.workspaceId),
        uuid(values.serviceId),
        revision(body.revision),
      );
      return { preview: previewMapping(input.mapping, input.service) };
    });
    routes.post('/api/workspaces/:workspaceId/invitations', async (request, reply) => {
      const current = await actor(request, reply, true);
      const id = uuid(params(request, ['workspaceId']).workspaceId);
      const body = object(request.body, ['email']);
      if (!repository) throw new IdentityError(503, 'unavailable');
      reply.header('cache-control', 'no-store');
      return reply.code(201).send({ invitation: await repository.invite(current, id, body.email) });
    });
    routes.delete(
      '/api/workspaces/:workspaceId/invitations/:invitationId',
      async (request, reply) => {
        const current = await actor(request, reply, true);
        const values = params(request, ['workspaceId', 'invitationId']);
        if (!repository) throw new IdentityError(503, 'unavailable');
        await repository.cancelInvitation(
          current,
          uuid(values.workspaceId),
          uuid(values.invitationId),
        );
        return reply.code(204).send();
      },
    );
    routes.post('/api/workspace-invitations/accept', async (request, reply) => {
      const current = await actor(request, reply, true);
      const body = object(request.body, ['token']);
      if (!repository) throw new IdentityError(503, 'unavailable');
      return repository.acceptInvitation(current, body.token);
    });
    routes.delete('/api/workspaces/:workspaceId/members/:userId', async (request, reply) => {
      const current = await actor(request, reply, true);
      const values = params(request, ['workspaceId', 'userId']);
      if (!repository) throw new IdentityError(503, 'unavailable');
      await repository.revokeMember(current, uuid(values.workspaceId), opaqueId(values.userId));
      return reply.code(204).send();
    });
  });
}
