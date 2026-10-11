import Fastify from 'fastify';
import { registerArgoIngress } from './features/argo-collection/ingress.ts';
import { type IdentityDependencies, registerIdentity } from './features/identity/routes.ts';
import { registerMeasurementIngress } from './features/measurements/ingress.ts';

export interface HealthDependency {
  ready: () => Promise<void>;
  close: () => Promise<void>;
}

export function createServer(database: HealthDependency, identity?: IdentityDependencies) {
  const server = Fastify({ logger: false, exposeHeadRoutes: false });
  server.get('/health/live', async () => ({ status: 'live' }));
  server.get('/health/ready', async (_request, reply) => {
    try {
      await database.ready();
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
  registerIdentity(server, identity);
  if (identity) {
    registerArgoIngress(server, { pool: identity.pool, argo: identity.argo ?? null });
    registerMeasurementIngress(server, {
      pool: identity.pool,
      configNow: () => identity.measurement ?? null,
      githubNow: () => identity.github ?? null,
      argoNow: () => identity.argo ?? null,
    });
  } else {
    for (const route of [
      '/api/argo/sources/:sourceId/operations',
      '/api/argo/sources/:sourceId/enrichments/:producerId',
      '/api/argo/sources/:sourceId/archives/:producerId',
    ])
      server.post(
        route,
        {
          onRequest: async (_request, reply) => {
            return reply
              .header('cache-control', 'no-store')
              .code(401)
              .send({ error: 'unauthorized' });
          },
        },
        async (_request, reply) => reply.code(401).send({ error: 'unauthorized' }),
      );
  }
  if (!identity) {
    const base = '/api/measurement/bases/:provider/:basisRunId/producers/:producerId';
    for (const [method, url] of [
      ['GET', base],
      ['POST', `${base}/reports`],
    ] as const) {
      server.route({
        method,
        url,
        onRequest: async (_request, reply) =>
          reply.header('cache-control', 'no-store').code(401).send({ error: 'unauthorized' }),
        handler: async (_request, reply) => reply.code(401).send({ error: 'unauthorized' }),
      });
    }
  }
  server.addHook('onClose', async () => database.close());
  return server;
}
