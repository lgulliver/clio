import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { readArgoConfig } from '../src/features/argo-collection/config.ts';
import { registerArgoIngress } from '../src/features/argo-collection/ingress.ts';

import { grantFixture } from './argo-fixture.ts';

describe('private Argo grants', () => {
  it('disables when absent and redacts invalid paths', async () => {
    expect(await readArgoConfig({})).toBeNull();
    await expect(
      readArgoConfig({ ARGO_INGESTION_GRANTS_FILE: '/private/missing-secret' }),
    ).rejects.toThrow(/^Invalid Argo ingestion configuration$/);
  });
  it('loads immutable scoped fingerprints without retaining paths or credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'argo-test-'));
    try {
      const tokenFile = join(dir, 'token'),
        grantsFile = join(dir, 'grants');
      await writeFile(tokenFile, `${'a'.repeat(64)}\n`, { mode: 0o600 });
      await writeFile(grantsFile, JSON.stringify([{ ...grantFixture(), tokenFile }]), {
        mode: 0o600,
      });
      const config = await readArgoConfig({ ARGO_INGESTION_GRANTS_FILE: grantsFile });
      expect(config?.grants[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(config)).not.toContain(dir);
      expect(JSON.stringify(config)).not.toContain('a'.repeat(64));
      expect(Object.isFrozen(config?.grants[0])).toBe(true);
      await chmod(tokenFile, 0o644);
      await expect(readArgoConfig({ ARGO_INGESTION_GRANTS_FILE: grantsFile })).rejects.toThrow(
        'Invalid Argo ingestion configuration',
      );
      await chmod(tokenFile, 0o600);
      await symlink(tokenFile, join(dir, 'link'));
      await writeFile(
        grantsFile,
        JSON.stringify([{ ...grantFixture(), tokenFile: join(dir, 'link') }]),
        { mode: 0o600 },
      );
      await expect(readArgoConfig({ ARGO_INGESTION_GRANTS_FILE: grantsFile })).rejects.toThrow(
        'Invalid Argo ingestion configuration',
      );
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});
it('rejects bad machine auth before malformed JSON, uniformly and without DB', async () => {
  const app = Fastify({ logger: false }),
    pool = new Pool();
  registerArgoIngress(app, { pool, argo: null });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/argo/sources/${randomUUID()}/operations`,
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(response.headers['cache-control']).toBe('no-store');
  } finally {
    await app.close();
    await pool.end();
  }
});
it('limits authenticated machine bursts before DB and refills 30/min without starving denied callers', async () => {
  const app = Fastify({ logger: false }),
    pool = new Pool();
  let now = 0;
  const scope = grantFixture(),
    token = 'b'.repeat(64);
  const { createHash } = await import('node:crypto');
  registerArgoIngress(app, {
    pool,
    argo: {
      grants: [
        {
          ...scope,
          tokenDigest: createHash('sha256').update(token).digest('hex'),
          fingerprint: 'c'.repeat(64),
        },
      ],
    },
    clock: () => now,
  });
  const post = () =>
    app.inject({
      method: 'POST',
      url: `/api/argo/sources/${scope.sourceId}/operations`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: '{',
    });
  try {
    for (let i = 0; i < 10; i++) expect((await post()).statusCode).toBe(400);
    expect((await post()).statusCode).toBe(503);
    now = 1999;
    expect((await post()).statusCode).toBe(503);
    now = 2000;
    expect((await post()).statusCode).toBe(400);
    expect((await post()).headers['retry-after']).toBe('2');
  } finally {
    await app.close();
    await pool.end();
  }
});
it('rejects duplicate source/app/token grants and includes credential/scope rotation in fingerprints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-config-'));
  try {
    const tokenFile = join(dir, 'token'),
      file = join(dir, 'grants'),
      scope = grantFixture();
    await writeFile(tokenFile, 'd'.repeat(64), { mode: 0o600 });
    await writeFile(file, JSON.stringify([{ ...scope, tokenFile }]), { mode: 0o600 });
    const first = await readArgoConfig({ ARGO_INGESTION_GRANTS_FILE: file });
    await writeFile(tokenFile, 'e'.repeat(64));
    const rotated = await readArgoConfig({ ARGO_INGESTION_GRANTS_FILE: file });
    expect(rotated?.grants[0]?.fingerprint).not.toBe(first?.grants[0]?.fingerprint);
    await writeFile(
      file,
      JSON.stringify([
        { ...scope, tokenFile },
        { ...grantFixture(), tokenFile },
      ]),
    );
    await expect(readArgoConfig({ ARGO_INGESTION_GRANTS_FILE: file })).rejects.toThrow(
      'Invalid Argo ingestion configuration',
    );
    await writeFile(file, JSON.stringify([{ ...scope, tokenFile, unexpected: 'private' }]));
    await expect(readArgoConfig({ ARGO_INGESTION_GRANTS_FILE: file })).rejects.toThrow(
      'Invalid Argo ingestion configuration',
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});
