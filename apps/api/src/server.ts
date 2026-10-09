import Fastify from 'fastify';

export interface HealthDependency {
  ready: () => Promise<void>;
  close: () => Promise<void>;
}

export function createServer(database: HealthDependency) {
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
  server.addHook('onClose', async () => database.close());
  return server;
}
