import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EvidenceBatch, identity } from '@clio/adapters';
import { describe, expect, it } from 'vitest';
import { captureGitHub } from '../src/features/github-collection/capture.ts';
import { parseGrants, readGitHubConfig } from '../src/features/github-collection/config.ts';
import { mergeHistory, parseEvidence } from '../src/features/github-collection/history.ts';
import {
  connectionInput,
  enqueueInput,
  instant,
  parseConnection,
  windowInput,
} from '../src/features/github-collection/input.ts';
import { parseResult, parseRun } from '../src/features/github-collection/result.ts';

const workspaceId = randomUUID(),
  serviceId = randomUUID();
const connection = parseConnection({
  workspaceId,
  serviceId,
  mode: 'live',
  provider: 'github',
  revision: 1,
  active: true,
  installationId: 10,
  repositoryId: 20,
  repositoryName: 'fixture-repo',
  accountLogin: 'fixture-owner',
  productionEnvironment: 'production',
  exposurePolicyReference: 'urn:fixture:policy:v1',
  repositoryDeploymentsBelongToService: true,
  observedAt: '2026-10-10T08:00:00.000001Z',
  verifiedAt: '2026-10-10T08:00:00Z',
});
const window = windowInput({ start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' });
const sourceId = identity('github', '10');
const deploymentId = identity(sourceId, 'deployment', 20, 30);
function evidence(observedAt = '2026-10-10T08:00:01Z'): EvidenceBatch {
  return {
    deployments: [
      {
        id: deploymentId,
        sourceId,
        sourceDeploymentId: identity('repository', 20, 'deployment', 30),
        revision: '2026-01-02T10:00:00Z',
        environment: 'production',
        eventAt: '2026-01-02T10:00:00Z',
        observedAt,
        sourceRef: `urn:clio:${identity('github', '10', 'repository', 20, 'deployment', 30)}`,
        repository: {
          repositoryId: identity('github', '10', 'repository', 20),
          tipSha: 'a'.repeat(40),
        },
        reconciledConfigurationRevision: null,
        configurationRepositoryId: null,
        deploymentTask: null,
        operationKind: 'rollout',
      },
    ],
    statuses: [
      {
        id: identity(sourceId, 'status', 20, 40),
        deploymentId,
        revision: '2026-01-02T10:01:00Z',
        environment: 'production',
        signal: 'success',
        health: null,
        consumerExposure: false,
        eventAt: '2026-01-02T10:01:00Z',
        observedAt,
        sourceRef: `urn:clio:${identity('github', '10', 'repository', 20, 'status', 40)}`,
      },
    ],
    completedStatusTraversals: [{ deploymentId, observedAt }],
  };
}
function capture(batch = evidence(), selected = connection, transportComplete = true) {
  return captureGitHub({
    runId: randomUUID(),
    connection: selected,
    serviceName: 'Fixture',
    window,
    evidence: batch,
    transportComplete,
    acquiredAt: '2026-10-10T08:00:02Z',
    databaseObservedAt: '2026-10-10T08:00:02.000001Z',
  });
}
describe('live GitHub boundaries', () => {
  it('loads private immutable configuration and redacts malformed/missing files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clio-github-config-'));
    const key = join(directory, 'key.pem'),
      grants = join(directory, 'grants.json');
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const grant = {
      workspaceId,
      installationId: 10,
      accountId: 11,
      accountType: 'Organization',
      repositoryIds: [20, 21],
    };
    const env = {
      GITHUB_APP_ID: '12',
      GITHUB_APP_PRIVATE_KEY_FILE: key,
      GITHUB_APP_GRANTS_FILE: grants,
    };
    try {
      await writeFile(key, privateKey, { mode: 0o600 });
      await writeFile(grants, JSON.stringify([grant]), { mode: 0o600 });
      const config = await readGitHubConfig(env);
      expect(config?.grants[0]?.repositoryIds).toEqual([20, 21]);
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config?.grants[0]?.repositoryIds)).toBe(true);
      await chmod(grants, 0o644);
      await expect(readGitHubConfig(env)).rejects.toThrow(
        'Invalid GitHub collection configuration',
      );
      await chmod(grants, 0o600);
      await symlink(key, join(directory, 'link.pem'));
      await expect(
        readGitHubConfig({ ...env, GITHUB_APP_PRIVATE_KEY_FILE: join(directory, 'link.pem') }),
      ).rejects.toThrow('Invalid GitHub collection configuration');
      await writeFile(grants, 'private payload');
      await expect(readGitHubConfig(env)).rejects.toThrow(
        'Invalid GitHub collection configuration',
      );
      await expect(readGitHubConfig({ GITHUB_APP_ID: '12' })).rejects.toThrow(
        'Invalid GitHub collection configuration',
      );
      expect(await readGitHubConfig({})).toBeNull();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('rejects checkout/private directory paths and empty/duplicate/oversized grants', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'clio-github-checkout-'));
    try {
      await writeFile(join(directory, '.git'), 'gitdir: /fixture');
      await writeFile(join(directory, 'key.pem'), 'private', { mode: 0o600 });
      await writeFile(join(directory, 'grants.json'), '[]', { mode: 0o600 });
      await expect(
        readGitHubConfig({
          GITHUB_APP_ID: '1',
          GITHUB_APP_PRIVATE_KEY_FILE: join(directory, 'key.pem'),
          GITHUB_APP_GRANTS_FILE: join(directory, 'grants.json'),
        }),
      ).rejects.toThrow('Invalid GitHub collection configuration');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    const grant = {
      workspaceId,
      installationId: 10,
      accountId: 11,
      accountType: 'Organization',
      repositoryIds: [20],
    };
    for (const value of [
      [grant, grant],
      [{ ...grant, repositoryIds: [] }],
      [{ ...grant, repositoryIds: [20, 20] }],
      [{ ...grant, repositoryIds: Array.from({ length: 101 }, (_, i) => i + 1) }],
      [{ ...grant, accountType: 'Bot' }],
      [{ ...grant, privateKey: 'no' }],
    ])
      expect(() => parseGrants(value, 12)).toThrow();
    expect(parseGrants([{ ...grant, repositoryIds: [20, 21] }], 12)[0]?.fingerprint).toBe(
      parseGrants([{ ...grant, repositoryIds: [21, 20] }], 12)[0]?.fingerprint,
    );
    expect(parseGrants([grant], 12)[0]?.fingerprint).not.toBe(
      parseGrants([grant], 13)[0]?.fingerprint,
    );
  });
  it('requires explicit whole-repository assignment and bounded closed calendar windows', () => {
    const input = {
      expectedRevision: null,
      installationId: 10,
      repositoryId: 20,
      productionEnvironment: 'production',
      exposurePolicyReference: null,
      repositoryDeploymentsBelongToService: true,
    };
    expect(connectionInput(input).exposurePolicyReference).toBeNull();
    expect(
      connectionInput({ ...input, exposurePolicyReference: '😀'.repeat(200) })
        .exposurePolicyReference,
    ).toBe('😀'.repeat(200));
    expect(() =>
      parseConnection({ ...connection, exposurePolicyReference: 'x'.repeat(201) }),
    ).toThrow();
    for (const bad of [
      { ...input, repositoryDeploymentsBelongToService: false },
      { ...input, productionEnvironment: ' production' },
      { ...input, repositoryId: '20' },
      { ...input, token: 'secret' },
      { ...input, exposurePolicyReference: undefined },
      { ...input, exposurePolicyReference: 'x'.repeat(201) },
    ])
      expect(() => connectionInput(bad)).toThrow();
    for (const w of [
      { start: '2026-01-01T00:00:00Z', end: '2026-04-02T00:00:00Z' },
      { start: '2026-01-01T01:00:00Z', end: '2026-01-03T00:00:00Z' },
      { start: '2026-02-30T00:00:00Z', end: '2026-03-03T00:00:00Z' },
      { start: window.end, end: window.start },
      { start: window.start, end: '2027-01-01T00:00:00Z' },
    ])
      expect(() =>
        enqueueInput(
          { connectionRevision: 1, requestId: randomUUID(), window: w },
          new Date('2026-10-10T08:00:00Z'),
        ),
      ).toThrow();
    expect(() => windowInput({ start: 'bad', end: window.end })).toThrowError(
      expect.objectContaining({ status: 400, message: 'invalid_request' }),
    );
    expect(instant('2026-10-10T08:00:00.000001Z') - instant('2026-10-10T08:00:00Z')).toBe(1n);
  });
  it('preserves success and earliest observations across later disappearance', () => {
    const old = evidence(),
      later = evidence('2026-10-10T08:00:01.000001Z');
    const merged = mergeHistory(old, later);
    expect(merged.deployments[0]?.observedAt).toBe(old.deployments[0]?.observedAt);
    expect(merged.statuses[0]?.observedAt).toBe(old.statuses[0]?.observedAt);
    const disappeared = mergeHistory(merged, {
      deployments: [],
      statuses: [],
      completedStatusTraversals: [],
    });
    expect(capture(disappeared, connection, false).result).toMatchObject({
      transportComplete: false,
      qualifyingCount: 1,
      deploymentFrequency: { count: 1, deploymentsPerDay: null },
      coverage: { collectionComplete: false },
    });
  });
  it('rejects conflicting status and metadata versions, foreign scope and hidden keys', () => {
    const old = evidence(),
      deployment = old.deployments[0],
      status = old.statuses[0];
    if (!deployment || !status) throw new Error('Missing fixture');
    expect(() =>
      mergeHistory(old, { ...old, statuses: [{ ...status, signal: 'failure' }] }),
    ).toThrow('Conflicting source record');
    expect(() =>
      capture(
        mergeHistory(old, {
          ...old,
          deployments: [
            {
              ...deployment,
              repository: {
                repositoryId: deployment.repository?.repositoryId ?? '',
                tipSha: 'b'.repeat(40),
              },
              revision: '2026-01-02T12:00:00Z',
            },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      parseEvidence(
        { ...old, deployments: [{ ...deployment, sourceId: 'github:999' }] },
        connection,
      ),
    ).toThrow();
    expect(() => parseEvidence({ ...old, token: 'secret' }, connection)).toThrow();
  });
  it('keeps empty evidence and un-attested exposure unknown, uses microsecond cutoff', () => {
    expect(
      capture({ deployments: [], statuses: [], completedStatusTraversals: [] }).result,
    ).toMatchObject({
      deploymentCount: 0,
      deploymentFrequency: { count: 0, status: 'provisional', deploymentsPerDay: null },
      coverage: { collectionComplete: false },
    });
    expect(
      capture(evidence(), { ...connection, exposurePolicyReference: null }).result,
    ).toMatchObject({ qualifyingCount: 0, unknownCount: 1, deploymentFrequency: { count: 0 } });
    expect(capture().result.evidenceCutoff).toBe('2026-10-10T08:00:02.000001Z');
    expect(() => capture(evidence('2026-10-10T08:00:03Z'))).toThrow(
      'Evidence observed after acquisition',
    );
  });
  it('strictly parses saved public results without recomputing source evidence', () => {
    const result = capture().result;
    expect(parseResult(JSON.parse(JSON.stringify(result)), connection, window)).toEqual(result);
    for (const bad of [
      { ...result, token: 'secret' },
      { ...result, coverage: { ...result.coverage, collectionComplete: true } },
      { ...result, connectionRevision: 2 },
      { ...result, window: { ...window, calendarDays: 3 } },
      { ...result, deploymentCount: 0 },
      { ...result, deploymentFrequency: { ...result.deploymentFrequency, qualityReasons: [] } },
    ])
      expect(() => parseResult(bad, connection, window)).toThrow();
    const row = {
      id: randomUUID(),
      workspace_id: workspaceId,
      service_id: serviceId,
      connection_revision: 1,
      connection_input: connection,
      window_input: window,
      status: 'succeeded',
      attempts: 1,
      created_at_text: '2026-10-10T08:00:01.000001Z',
      updated_at_text: '2026-10-10T08:00:03.000001Z',
      completed_at_text: '2026-10-10T08:00:03.000001Z',
      result,
      failure_code: null,
      lease_token: 'private',
    };
    expect(JSON.stringify(parseRun(row))).not.toContain('private');
    expect(() => parseRun({ ...row, completed_at_text: '2026-10-10T08:00:03.000002Z' })).toThrow();
  });
});
