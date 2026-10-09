import { describe, expect, it, vi } from 'vitest';
import { readConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';

describe('health-only API', () => {
  it('keeps liveness independent of readiness and redacts dependency failures', async () => {
    const ready = vi.fn().mockRejectedValue(new Error('postgres://secret:password@host/private'));
    const close = vi.fn().mockResolvedValue(undefined);
    const server = createServer({ ready, close });
    try {
      const live = await server.inject('/health/live');
      expect(live.statusCode).toBe(200);
      expect(live.json()).toEqual({ status: 'live' });
      expect(ready).not.toHaveBeenCalled();
      const unavailable = await server.inject('/health/ready');
      expect(unavailable.statusCode).toBe(503);
      expect(unavailable.json()).toEqual({ status: 'unavailable' });
      ready.mockResolvedValue(undefined);
      const available = await server.inject('/health/ready');
      expect(available.statusCode).toBe(200);
      expect(available.json()).toEqual({ status: 'ready' });
      expect((await server.inject('/workspaces')).statusCode).toBe(404);
      expect((await server.inject({ method: 'POST', url: '/health/live' })).statusCode).toBe(404);
      expect((await server.inject({ method: 'HEAD', url: '/health/live' })).statusCode).toBe(404);
    } finally {
      await server.close();
    }
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('server configuration boundary', () => {
  it('uses loopback and validates external configuration without exposing secrets', () => {
    expect(readConfig({ DATABASE_URL: 'postgres://localhost/clio' })).toEqual({
      databaseUrl: 'postgres://localhost/clio',
      host: '127.0.0.1',
      port: 3000,
    });
    expect(() => readConfig({})).toThrow('DATABASE_URL is required');
    expect(() => readConfig({ DATABASE_URL: 'https://secret@example.org' })).toThrow(
      'PostgreSQL URL',
    );
    for (const port of ['', '0', '65536', '1.5', 'garbage']) {
      expect(() => readConfig({ DATABASE_URL: 'postgres://localhost/clio', PORT: port })).toThrow(
        'PORT',
      );
    }
  });
});
