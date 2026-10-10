import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { expect, it } from 'vitest';
import { registerArgoIngress } from '../src/features/argo-collection/ingress.ts';
import { connectionInput } from '../src/features/argo-collection/input.ts';

it('archive selection defaults absent fields to none and accepts explicit producer ID', () => {
  const input = {
    expectedRevision: null,
    sourceId: randomUUID(),
    applicationOperationsBelongToService: true,
    exposurePolicyReference: null,
  };
  expect(connectionInput(input)).toHaveProperty('archiveProducerId', null);
  const id = randomUUID();
  expect(connectionInput({ ...input, archiveProducerId: id })).toHaveProperty(
    'archiveProducerId',
    id,
  );
  expect(() => connectionInput({ ...input, archiveProducerId: '' })).toThrow();
});
it('archive ingress authenticates before parsing malformed JSON or accessing database', async () => {
  const app = Fastify({ logger: false }),
    pool = new Pool();
  registerArgoIngress(app, { pool, argo: null });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/api/argo/sources/${randomUUID()}/archives/${randomUUID()}`,
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  } finally {
    await app.close();
    await pool.end();
  }
});

it('private archive grants bind exact native scope and reject cross-capability credential reuse', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { readArgoConfig } = await import('../src/features/argo-collection/config.ts');
  const { grantFixture } = await import('./argo-fixture.ts');
  const directory = await mkdtemp(join(tmpdir(), 'archive-config-'));
  try {
    const scope = grantFixture(),
      native = join(directory, 'native.json'),
      archive = join(directory, 'archive.json'),
      nativeToken = join(directory, 'native-token'),
      archiveToken = join(directory, 'archive-token');
    await writeFile(nativeToken, 'a'.repeat(64), { mode: 0o600 });
    await writeFile(archiveToken, 'b'.repeat(64), { mode: 0o600 });
    await writeFile(native, JSON.stringify([{ ...scope, tokenFile: nativeToken }]), {
      mode: 0o600,
    });
    const row = {
      ...scope,
      producerId: randomUUID(),
      journalId: randomUUID(),
      policyReference: 'urn:fixture:archive:v1',
      capability: 'operation_archive',
      tokenFile: archiveToken,
    };
    await writeFile(archive, JSON.stringify([row]), { mode: 0o600 });
    const env = { ARGO_INGESTION_GRANTS_FILE: native, ARGO_ARCHIVE_GRANTS_FILE: archive };
    const config = await readArgoConfig(env);
    expect(config?.archives?.[0]).toMatchObject({
      producerId: row.producerId,
      journalId: row.journalId,
    });
    expect(JSON.stringify(config)).not.toContain(directory);
    expect(JSON.stringify(config)).not.toContain('b'.repeat(64));
    for (const invalid of [
      { ...row, tokenFile: nativeToken },
      { ...row, project: 'foreign' },
      { ...row, capability: 'consumer_exposure' },
      { ...row, extra: true },
    ]) {
      await writeFile(archive, JSON.stringify([invalid]));
      await expect(readArgoConfig(env)).rejects.toThrow('Invalid Argo ingestion configuration');
    }
    await writeFile(archive, JSON.stringify([row]));
    await writeFile(archiveToken, 'c'.repeat(64));
    expect((await readArgoConfig(env))?.archives?.[0]?.fingerprint).not.toBe(
      config?.archives?.[0]?.fingerprint,
    );
    const enrichment = join(directory, 'enrichment.json');
    await writeFile(
      enrichment,
      JSON.stringify([
        {
          sourceId: scope.sourceId,
          producerId: randomUUID(),
          capability: 'consumer_exposure',
          policyReference: 'p',
          repositoryIds: [],
          tokenFile: archiveToken,
        },
      ]),
      { mode: 0o600 },
    );
    await expect(
      readArgoConfig({ ...env, ARGO_ENRICHMENT_GRANTS_FILE: enrichment }),
    ).rejects.toThrow('Invalid Argo ingestion configuration');
    await expect(readArgoConfig({ ARGO_ARCHIVE_GRANTS_FILE: archive })).rejects.toThrow(
      'Invalid Argo ingestion configuration',
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('archive summary retains omitted diagnostics and rejects contradictory counts/private keys', async () => {
  const { parseArchiveSummary } = await import(
    '../src/features/argo-collection/archive-summary.ts'
  );
  const summary = {
    journalId: randomUUID(),
    producerId: randomUUID(),
    policyReference: 'p',
    lastSequence: 2,
    lastSuccessfulReconciliationAt: null,
    sealedInterval: null,
    entryCount: 2,
    gapCount: 1,
    missingIntervalCount: 35,
    missingIntervals: Array.from({ length: 32 }, () => ({
      start: '2026-01-01T00:00:00Z',
      end: '2026-01-02T00:00:00Z',
      reason: 'capture_interrupted',
    })),
    omittedIntervalCount: 3,
  };
  expect(parseArchiveSummary(summary).omittedIntervalCount).toBe(3);
  for (const invalid of [
    { ...summary, omittedIntervalCount: 0 },
    { ...summary, gapCount: 3 },
    { ...summary, token: 'private' },
    {
      ...summary,
      missingIntervals: [
        { start: '2026-01-02T00:00:00Z', end: '2026-01-01T00:00:00Z', reason: 'bad' },
      ],
      omittedIntervalCount: 34,
    },
  ])
    expect(() => parseArchiveSummary(invalid)).toThrow();
});
it('snapshot archive diagnostics remain bounded, cutoff-fenced and older results remain readable', async () => {
  const { captureArgo } = await import('../src/features/argo-collection/capture.ts');
  const { parseResult } = await import('../src/features/argo-collection/result.ts');
  const { windowInput } = await import('../src/features/argo-collection/input.ts');
  const { grantFixture } = await import('./argo-fixture.ts');
  const scope = grantFixture(),
    producer = { producerId: randomUUID(), journalId: randomUUID(), policyReference: 'fixture' };
  const connection = {
    workspaceId: scope.workspaceId,
    serviceId: scope.serviceId,
    sourceId: scope.sourceId,
    applicationName: scope.applicationName,
    applicationNamespace: scope.applicationNamespace,
    instance: scope.instance,
    productionEnvironment: scope.environment,
    mode: 'live' as const,
    provider: 'argocd' as const,
    revision: 1,
    active: true,
    exposurePolicyReference: null,
    applicationOperationsBelongToService: true as const,
    observedAt: '2026-01-01T00:00:00Z',
  };
  const window = windowInput({ start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' });
  const input = {
    runId: randomUUID(),
    connection,
    window,
    serviceName: 'archive',
    evidence: { deployments: [], statuses: [] },
    databaseObservedAt: '2026-01-03T00:00:00Z',
    stats: {
      retainedReceiptCount: 0,
      retainedEvidenceCount: 0,
      recordedGapCount: 0,
      gapReasons: {},
      rejectionCount: 0,
      scopeDriftCount: 0,
      observationPeriod: { start: null, end: '2026-01-03T00:00:00Z' },
    },
  };
  const legacy = captureArgo(input);
  expect(parseResult(legacy.result, connection, window).archiveSummary).toBeUndefined();
  const summary = {
    ...producer,
    lastSequence: 0,
    lastSuccessfulReconciliationAt: '2026-01-02T00:00:00Z',
    sealedInterval: { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' },
    entryCount: 0,
    gapCount: 0,
    missingIntervalCount: 0,
    missingIntervals: [],
    omittedIntervalCount: 0,
  };
  const selected = { ...connection, archiveProducer: producer };
  const archived = captureArgo({ ...input, connection: selected, archiveSummary: summary });
  expect(archived.result.archiveSummary).toEqual(summary);
  expect(archived.result.coverage).toEqual({
    collectionComplete: false,
    deploymentHistoryComplete: false,
    recoveryEvidenceComplete: false,
  });
  expect(() =>
    parseResult(
      {
        ...archived.result,
        archiveSummary: { ...summary, lastSuccessfulReconciliationAt: '2026-01-04T00:00:00Z' },
      },
      selected,
      window,
    ),
  ).toThrow();
  expect(() =>
    parseResult(
      { ...archived.result, archiveSummary: { ...summary, producerId: randomUUID() } },
      selected,
      window,
    ),
  ).toThrow();
  expect(() =>
    captureArgo({
      ...input,
      connection: selected,
      archiveSummary: summary,
      archiveLineages: [
        {
          receiptId: randomUUID(),
          sourceRef: 'urn:fixture:archive',
          capturedAt: '2026-01-01T00:00:00Z',
          observedAt: '2026-01-04T00:00:00Z',
        },
      ],
    }),
  ).toThrow();
});
