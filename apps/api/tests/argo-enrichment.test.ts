import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { readArgoConfig } from '../src/features/argo-collection/config.ts';
import { registerArgoIngress } from '../src/features/argo-collection/ingress.ts';
import { connectionInput, parseConnection } from '../src/features/argo-collection/input.ts';
import { grantFixture } from './argo-fixture.ts';

it('private capabilities derive native scope, rotate fingerprints and reject malformed/duplicate grants', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'argo-enrichment-'));
  try {
    const native = join(dir, 'native'),
      producers = join(dir, 'producers');
    const nativeToken = join(dir, 'native-token'),
      producerToken = join(dir, 'producer-token');
    const scope = grantFixture(),
      producerId = randomUUID();
    await writeFile(nativeToken, 'a'.repeat(64), { mode: 0o600 });
    await writeFile(producerToken, 'b'.repeat(64), { mode: 0o600 });
    await writeFile(native, JSON.stringify([{ ...scope, tokenFile: nativeToken }]), {
      mode: 0o600,
    });
    const grant = {
      sourceId: scope.sourceId,
      producerId,
      capability: 'application_provenance',
      policyReference: 'urn:fixture:build:v1',
      repositoryIds: ['github:fixture/app'],
      tokenFile: producerToken,
    };
    await writeFile(producers, JSON.stringify([grant]), { mode: 0o600 });
    const env = { ARGO_INGESTION_GRANTS_FILE: native, ARGO_ENRICHMENT_GRANTS_FILE: producers };
    const config = await readArgoConfig(env);
    expect(config?.producers?.[0]).toMatchObject({
      ...scope,
      producerId,
      repositoryIds: ['github:fixture/app'],
    });
    expect(JSON.stringify(config)).not.toContain(dir);
    expect(Object.isFrozen(config?.producers)).toBe(true);
    await writeFile(producerToken, 'c'.repeat(64));
    expect((await readArgoConfig(env))?.producers?.[0]?.fingerprint).not.toBe(
      config?.producers?.[0]?.fingerprint,
    );
    for (const invalid of [
      { ...grant, capability: 'consumer_exposure' },
      { ...grant, repositoryIds: [] },
      { ...grant, repositoryIds: ['unnamespaced'] },
      { ...grant, extra: true },
      { ...grant, sourceId: randomUUID() },
      { ...grant, tokenFile: nativeToken },
    ]) {
      await writeFile(producers, JSON.stringify([invalid]));
      await expect(readArgoConfig(env)).rejects.toThrow('Invalid Argo ingestion configuration');
    }
    await writeFile(producers, JSON.stringify([grant, grant]));
    await expect(readArgoConfig(env)).rejects.toThrow('Invalid Argo ingestion configuration');
    await expect(readArgoConfig({ ARGO_ENRICHMENT_GRANTS_FILE: producers })).rejects.toThrow(
      'Invalid Argo ingestion configuration',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('connection selections default only absent fields, reject duplicates/null and keep legacy JSON readable', () => {
  const input = {
    expectedRevision: null,
    sourceId: randomUUID(),
    applicationOperationsBelongToService: true,
    exposurePolicyReference: null,
  };
  expect(connectionInput(input).enrichmentProducerIds).toEqual([]);
  for (const enrichmentProducerIds of [null, [randomUUID(), 'bad'], ['extra'], undefined])
    expect(() => connectionInput({ ...input, enrichmentProducerIds })).toThrow();
  const id = randomUUID();
  expect(() => connectionInput({ ...input, enrichmentProducerIds: [id, id] })).toThrow();
  const stored = {
    ...grantFixture(),
    workspaceId: randomUUID(),
    serviceId: randomUUID(),
    mode: 'live',
    provider: 'argocd',
    revision: 1,
    active: true,
    applicationOperationsBelongToService: true,
    exposurePolicyReference: null,
    productionEnvironment: 'production',
    observedAt: '2026-01-01T00:00:00Z',
  };
  const {
    applicationUid: _uid,
    project: _project,
    destinationClusterId: _cluster,
    destinationServer: _server,
    destinationName: _name,
    destinationNamespace: _namespace,
    configurationRepositoryId: _repo,
    repoURL: _url,
    environment: _environment,
    ...legacy
  } = stored;
  expect(parseConnection(legacy).enrichmentProducers).toBeUndefined();
  expect(() => parseConnection({ ...legacy, enrichmentProducers: null })).toThrow();
  expect(() =>
    parseConnection({
      ...legacy,
      enrichmentProducers: [
        {
          producerId: id,
          capability: 'consumer_exposure',
          policyReference: 'p',
          tokenDigest: 'private',
        },
      ],
    }),
  ).toThrow();
});
it('enrichment auth redacts unknown IDs and rejects malformed JSON before DB access', async () => {
  const app = Fastify({ logger: false }),
    pool = new Pool();
  registerArgoIngress(app, { pool, argo: null });
  try {
    for (const url of [
      `/api/argo/sources/${randomUUID()}/enrichments/${randomUUID()}`,
      '/api/argo/sources/bad/enrichments/bad',
    ]) {
      const response = await app.inject({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        payload: '{',
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'unauthorized' });
    }
  } finally {
    await app.close();
    await pool.end();
  }
});
it('health-only server retains uniform enrichment unauthorized response before parsing', async () => {
  const { createServer } = await import('../src/server.ts');
  const app = createServer({ ready: async () => {}, close: async () => {} });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/argo/sources/${randomUUID()}/enrichments/${randomUUID()}`,
      headers: { 'content-type': 'application/json', cookie: 'session=fictional' },
      payload: '{',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    expect(response.headers['cache-control']).toBe('no-store');
  } finally {
    await app.close();
  }
});
