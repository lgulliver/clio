import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactDigest,
  buildArtifact,
  captureBaseline,
  nativeNotification,
  observeArtifact,
  parseReceipt,
  provenanceEvent,
  publishEvidence,
  publishNative,
  renderManifest,
  saveEvidence,
  saveNativeNotification,
} from '../../../infra/argocd/evidence-demo/producers.ts';

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function temporary() {
  const directory = await mkdtemp(join('/var/tmp', 'clio-demo-'));
  directories.push(directory);
  return directory;
}
const bytes = Buffer.from('<html>Sandbox consumers only — not production</html>\n');
const receipt = {
  contract: 'clio.sandbox.git-artifact.v1',
  repository_id: 'github:example/application',
  commit_sha: 'a'.repeat(40),
  artifact_digest: artifactDigest(bytes),
  source_path: 'infra/argocd/evidence-demo/app/index.html',
};
const producer = { sourceId: randomUUID(), producerId: randomUUID() };
const operationId = randomUUID();
function notification(startedAt = '2026-01-01T00:00:00Z') {
  return {
    contract: 'clio.argocd.notification.v1',
    application: {
      uid: randomUUID(),
      name: 'demo',
      namespace: 'argocd',
      project: 'default',
      destination: { server: 'https://kubernetes.default.svc', name: null, namespace: 'demo' },
      repoURL: 'https://example.com/config.git',
      hasSources: false,
      hasSourceHydrator: false,
    },
    operation: {
      phase: 'Failed',
      startedAt,
      finishedAt: startedAt,
      retryCount: 0,
      info: [
        { name: 'clio.operation-id', value: operationId },
        { name: 'clio.operation-kind', value: 'rollout' },
      ],
      initiatedBy: { username: 'sandbox', automated: false },
      revision: 'config-42',
      revisions: [],
    },
    health: { status: 'Degraded', lastTransitionTime: startedAt },
  };
}
function baseline(endpoint: string, overrides: Record<string, unknown> = {}) {
  return {
    contract: 'clio.sandbox.http-baseline.v1',
    operation_id: operationId,
    endpoint,
    observed_at: '2025-12-31T00:00:00Z',
    http_status: 404,
    artifact_digest: artifactDigest(new Uint8Array()),
    byte_count: 0,
    ...overrides,
  };
}
function fetchResponse(response: Response): typeof fetch {
  return async () => response;
}
describe('independent sandbox producers', () => {
  it('maps actual Application fields without replacing operation identity, timestamps or initiator', () => {
    const native = notification('2026-01-01T00:00:00.000123Z');
    const application = {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: {
        uid: native.application.uid,
        name: native.application.name,
        namespace: native.application.namespace,
        resourceVersion: 'ignored-resource-version',
      },
      spec: {
        project: native.application.project,
        destination: native.application.destination,
        source: { repoURL: native.application.repoURL, targetRevision: 'main', path: 'manifests' },
      },
      status: {
        sync: { status: 'OutOfSync' },
        operationState: {
          phase: native.operation.phase,
          startedAt: native.operation.startedAt,
          finishedAt: native.operation.finishedAt,
          retryCount: 0,
          operation: {
            info: native.operation.info,
            initiatedBy: { username: 'actual-operator', automated: true },
            sync: { revision: 'requested-revision-not-reconciled' },
          },
          syncResult: {
            revision: native.operation.revision,
            revisions: native.operation.revisions,
            resources: [],
          },
        },
        health: native.health,
      },
    };
    expect(nativeNotification(application)).toEqual({
      ...native,
      operation: {
        ...native.operation,
        initiatedBy: { username: 'actual-operator', automated: true },
      },
    });
  });
  it('preserves absent native timestamps as gaps and rejects missing or invented rollout identity', async () => {
    const directory = await temporary();
    const native = notification();
    const application = {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: { uid: native.application.uid, name: 'demo', namespace: 'argocd' },
      spec: {
        project: 'default',
        destination: native.application.destination,
        source: { repoURL: native.application.repoURL },
      },
      status: { operationState: { operation: { info: native.operation.info } } },
    };
    expect(nativeNotification(application)).toMatchObject({
      operation: {
        phase: null,
        startedAt: null,
        finishedAt: null,
        revision: null,
        retryCount: 0,
        initiatedBy: { username: null, automated: false },
      },
      health: { status: null, lastTransitionTime: null },
    });
    expect(() =>
      nativeNotification({
        ...application,
        status: { operationState: { operation: { info: [] } } },
      }),
    ).toThrow();
    expect(() =>
      nativeNotification({
        ...application,
        status: {
          operationState: {
            operation: {
              info: [
                { name: 'clio.operation-id', value: 'config-sha' },
                { name: 'clio.operation-kind', value: 'rollout' },
              ],
            },
          },
        },
      }),
    ).toThrow();
    const input = join(directory, 'application.json');
    const output = join(directory, 'native.json');
    await writeFile(input, JSON.stringify(application));
    await expect(
      saveNativeNotification(input, join(directory, 'wrong-operation.json'), randomUUID()),
    ).rejects.toThrow();
    await saveNativeNotification(input, output, operationId.toUpperCase());
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(nativeNotification(application));
    await expect(saveNativeNotification(input, output)).rejects.toThrow();
  });
  it('rejects impossible native calendars and malformed external fields', () => {
    const native = notification();
    const base = {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Application',
      metadata: { uid: native.application.uid, name: 'demo', namespace: 'argocd' },
      spec: { project: 'default', destination: native.application.destination },
      status: {
        operationState: {
          startedAt: '2026-02-30T00:00:00Z',
          operation: { info: native.operation.info },
        },
      },
    };
    expect(() => nativeNotification(base)).toThrow();
    expect(() =>
      nativeNotification({
        ...base,
        status: {
          operationState: { retryCount: 'zero', operation: { info: native.operation.info } },
        },
      }),
    ).toThrow();
    expect(() => nativeNotification({ ...base, metadata: { name: 'demo' } })).toThrow();
  });
  it('builds committed bytes despite dirty worktree and refuses reused output', async () => {
    const directory = await temporary();
    await exec('git', ['init', directory]);
    await mkdir(join(directory, 'infra/argocd/evidence-demo/app'), { recursive: true });
    const file = join(directory, receipt.source_path);
    await writeFile(file, bytes);
    await exec('git', ['-C', directory, 'add', '.']);
    await exec('git', [
      '-C',
      directory,
      '-c',
      'user.name=Demo',
      '-c',
      'user.email=demo@example.invalid',
      'commit',
      '-m',
      'feat(demo): record artifact',
    ]);
    const { stdout } = await exec('git', ['-C', directory, 'rev-parse', 'HEAD']);
    await writeFile(file, 'dirty');
    const input = {
      gitDirectory: directory,
      commitSha: stdout.trim(),
      repositoryId: receipt.repository_id,
      outputDirectory: join(directory, 'build'),
    };
    const previousGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = '/nonexistent/override-must-not-apply';
    let built: Awaited<ReturnType<typeof buildArtifact>>;
    try {
      built = await buildArtifact(input);
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
    }
    expect(await readFile(join(input.outputDirectory, 'index.html'))).toEqual(bytes);
    expect(built.artifact_digest).toBe(receipt.artifact_digest);
    await expect(buildArtifact(input)).rejects.toThrow();
    await expect(buildArtifact({ ...input, commitSha: 'HEAD' })).rejects.toThrow();
    await rm(file);
    await symlink('not-an-artifact', file);
    await exec('git', ['-C', directory, 'add', '.']);
    await exec('git', [
      '-C',
      directory,
      '-c',
      'user.name=Demo',
      '-c',
      'user.email=demo@example.invalid',
      'commit',
      '-m',
      'test(demo): record symlink rejection',
    ]);
    const symlinkCommit = await exec('git', ['-C', directory, 'rev-parse', 'HEAD']);
    await expect(
      buildArtifact({
        ...input,
        commitSha: symlinkCommit.stdout.trim(),
        outputDirectory: join(directory, 'symlink-build'),
      }),
    ).rejects.toThrow();
  });
  it('rejects altered, unknown-field and non-UTF8 build evidence', () => {
    expect(() => provenanceEvent(Buffer.from('changed'), receipt, producer)).toThrow();
    expect(() => parseReceipt({ ...receipt, image_digest: 'invented' })).toThrow();
    const invalid = Buffer.from([0xff]);
    expect(() =>
      provenanceEvent(invalid, { ...receipt, artifact_digest: artifactDigest(invalid) }, producer),
    ).toThrow();
  });
  it('observes exact bytes without Argo health gate and binds real operation fields', async () => {
    const native = notification();
    const before = Date.now();
    const result = await observeArtifact(
      {
        endpoint: 'http://127.0.0.1:8099/index.html',
        bytes,
        receipt,
        notification: native,
        baseline: baseline('http://127.0.0.1:8099/index.html'),
        producer,
      },
      fetchResponse(new Response(bytes)),
    );
    expect(result.event).toMatchObject({
      application_uid: native.application.uid,
      configuration_revision: 'config-42',
      operation_id: native.operation.info[0]?.value,
      subject: { kind: 'artifact', digest: receipt.artifact_digest },
    });
    expect(Date.parse(result.event.effective_at)).toBeGreaterThanOrEqual(before);
    expect(result.observation.byte_count).toBe(bytes.length);
  });
  it('requires an earlier different artifact or 404 baseline rather than unchanged heartbeat', async () => {
    const endpoint = 'http://localhost:8099/index.html';
    const input = {
      endpoint,
      bytes,
      receipt,
      notification: notification(),
      producer,
      baseline: baseline(endpoint),
    };
    for (const previous of [
      undefined,
      baseline(endpoint, {
        http_status: 200,
        artifact_digest: receipt.artifact_digest,
        byte_count: bytes.length,
      }),
      baseline(endpoint, { observed_at: '2026-01-01T00:00:00Z' }),
      baseline(endpoint, { observed_at: '2026-01-02T00:00:00Z' }),
      baseline('http://localhost:8100/index.html'),
    ]) {
      await expect(
        observeArtifact({ ...input, baseline: previous }, fetchResponse(new Response(bytes))),
      ).rejects.toThrow();
    }
    const changed = baseline(endpoint, {
      http_status: 200,
      artifact_digest: artifactDigest(Buffer.from('previous version')),
      byte_count: 16,
    });
    expect(
      (await observeArtifact({ ...input, baseline: changed }, fetchResponse(new Response(bytes))))
        .event.subject.digest,
    ).toBe(receipt.artifact_digest);
    expect(
      (await observeArtifact(input, fetchResponse(new Response(bytes)))).observation.baseline
        .http_status,
    ).toBe(404);
  });
  it('binds one baseline to its exact operation UUID and rejects reuse by a later rollout', async () => {
    const endpoint = 'http://localhost:8099/index.html';
    const original = notification();
    const previous = baseline(endpoint);
    const input = {
      endpoint,
      bytes,
      receipt,
      notification: original,
      producer,
      baseline: previous,
    };
    expect(
      (await observeArtifact(input, fetchResponse(new Response(bytes)))).event.operation_id,
    ).toBe(operationId);
    const later = notification();
    later.operation.info[0] = { name: 'clio.operation-id', value: randomUUID() };
    await expect(
      observeArtifact({ ...input, notification: later }, fetchResponse(new Response(bytes))),
    ).rejects.toThrow();
  });
  it('captures actual initial 404 or prior bytes at current time and rejects bad baseline HTTP', async () => {
    const endpoint = 'http://localhost:8099/index.html';
    const before = Date.now();
    const missing = await captureBaseline(
      endpoint,
      operationId,
      fetchResponse(new Response(null, { status: 404 })),
    );
    expect(missing.http_status).toBe(404);
    expect(Date.parse(missing.observed_at)).toBeGreaterThanOrEqual(before);
    const previous = Buffer.from('prior sandbox version');
    expect(
      await captureBaseline(endpoint, operationId, fetchResponse(new Response(previous))),
    ).toMatchObject({
      http_status: 200,
      artifact_digest: artifactDigest(previous),
      byte_count: previous.length,
    });
    for (const response of [
      new Response(null, { status: 302 }),
      new Response(null, { status: 503 }),
      new Response('x'.repeat(65537)),
    ])
      await expect(
        captureBaseline(endpoint, operationId, fetchResponse(response)),
      ).rejects.toThrow();
  });
  it('returns no assertion on mismatch, HTTP failure, redirect, compressed or oversized body', async () => {
    const input = {
      endpoint: 'http://localhost:8099/index.html',
      bytes,
      receipt,
      notification: notification(),
      baseline: baseline('http://localhost:8099/index.html'),
      producer,
    };
    for (const response of [
      new Response('wrong'),
      new Response(bytes, { status: 503 }),
      new Response(null, { status: 302, headers: { Location: '/other' } }),
      new Response(bytes, { headers: { 'Content-Encoding': 'gzip' } }),
      new Response('x'.repeat(65537)),
    ]) {
      await expect(observeArtifact(input, fetchResponse(response))).rejects.toThrow();
    }
    await expect(
      observeArtifact(input, async () => {
        throw new Error('timeout');
      }),
    ).rejects.toThrow();
  });
  it('rejects backdating, unsupported operation, URL credentials and non-loopback URLs', async () => {
    const input = {
      endpoint: 'http://localhost/index.html',
      bytes,
      receipt,
      notification: notification('2999-01-01T00:00:00Z'),
      baseline: baseline('http://localhost/index.html'),
      producer,
    };
    await expect(observeArtifact(input, fetchResponse(new Response(bytes)))).rejects.toThrow();
    for (const endpoint of [
      'https://localhost/index.html',
      'http://example.com/index.html',
      'http://user@localhost/index.html',
      'http://localhost/other',
      'http://localhost/index.html?secret=value',
    ]) {
      await expect(
        observeArtifact({ ...input, endpoint }, fetchResponse(new Response(bytes))),
      ).rejects.toThrow();
    }
    const unsupported = notification();
    unsupported.operation.info[1] = { name: 'clio.operation-kind', value: 'self_heal' };
    await expect(
      observeArtifact({ ...input, notification: unsupported }, fetchResponse(new Response(bytes))),
    ).rejects.toThrow();
  });
  it('retains identical event for missing-anchor retry and never rewrites persisted evidence', async () => {
    const directory = await temporary();
    const event = provenanceEvent(bytes, receipt, producer);
    const output = join(directory, 'evidence');
    await saveEvidence(output, event);
    const tokenFile = join(directory, 'private.token');
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    const captured: string[] = [];
    const fetcher: typeof fetch = async (_url, options) => {
      captured.push(String(options?.body));
      return new Response(null, { status: captured.length === 1 ? 409 : 200 });
    };
    const input = { baseUrl: 'http://localhost:3000', event, tokenFile };
    expect(await publishEvidence(input, fetcher)).toBe(409);
    expect(await publishEvidence(input, fetcher)).toBe(200);
    expect(captured[0]).toBe(captured[1]);
    expect(JSON.parse(await readFile(join(output, 'event.json'), 'utf8'))).toEqual(event);
    await expect(saveEvidence(output, event)).rejects.toThrow();
    await writeFile(tokenFile, 'secret', { mode: 0o600 });
    await expect(publishEvidence(input, fetcher)).rejects.toThrow();
  });
  it('publishes native evidence with normalized source UUID and rejects proxy environments before HTTP', async () => {
    const directory = await temporary();
    const tokenFile = join(directory, 'private.token');
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    const native = notification();
    const urls: string[] = [];
    const fetcher: typeof fetch = async (url, options) => {
      urls.push(String(url));
      expect(JSON.parse(String(options?.body))).toEqual(native);
      return new Response(null, { status: 202 });
    };
    expect(
      await publishNative(
        {
          notification: native,
          sourceId: producer.sourceId.toUpperCase(),
          baseUrl: 'http://localhost:3000',
          tokenFile,
        },
        fetcher,
      ),
    ).toBe(202);
    expect(urls).toEqual([
      `http://localhost:3000/api/argo/sources/${producer.sourceId}/operations`,
    ]);
    const previous = process.env.NODE_USE_ENV_PROXY;
    process.env.NODE_USE_ENV_PROXY = '1';
    try {
      await expect(
        publishNative(
          {
            notification: native,
            sourceId: producer.sourceId,
            baseUrl: 'http://localhost:3000',
            tokenFile,
          },
          fetcher,
        ),
      ).rejects.toThrow();
      await expect(
        publishEvidence(
          {
            event: provenanceEvent(bytes, receipt, producer),
            baseUrl: 'http://localhost:3000',
            tokenFile,
          },
          fetcher,
        ),
      ).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env.NODE_USE_ENV_PROXY;
      else process.env.NODE_USE_ENV_PROXY = previous;
    }
    expect(urls).toHaveLength(1);
  });
  it('rejects symlink paths, unsafe permissions and tokens inside Git before fetch', async () => {
    const directory = await temporary();
    const tokenFile = join(directory, 'private.token');
    await writeFile(tokenFile, 'a'.repeat(64), { mode: 0o600 });
    const input = {
      baseUrl: 'http://localhost:3000',
      event: provenanceEvent(bytes, receipt, producer),
      tokenFile,
    };
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      requests += 1;
      return new Response(null);
    };
    await chmod(tokenFile, 0o644);
    await expect(publishEvidence(input, fetcher)).rejects.toThrow();
    await chmod(tokenFile, 0o600);
    const link = join(directory, 'linked.token');
    await symlink(tokenFile, link);
    await expect(publishEvidence({ ...input, tokenFile: link }, fetcher)).rejects.toThrow();
    const parentLink = join(directory, 'linked-parent');
    await symlink(directory, parentLink);
    await expect(
      publishEvidence({ ...input, tokenFile: join(parentLink, 'private.token') }, fetcher),
    ).rejects.toThrow();
    const fifo = join(directory, 'fifo.token');
    await exec('mkfifo', [fifo]);
    await expect(publishEvidence({ ...input, tokenFile: fifo }, fetcher)).rejects.toThrow();
    await mkdir(join(directory, '.git'));
    await expect(publishEvidence(input, fetcher)).rejects.toThrow();
    expect(requests).toBe(0);
  });
  it('renders digest-addressed immutable ConfigMap exact bytes and explicit pinned image', () => {
    const manifest: unknown = JSON.parse(
      renderManifest(
        bytes,
        receipt,
        `docker.io/library/nginx:1.29.3-alpine@sha256:${'b'.repeat(64)}`,
      ),
    );
    expect(manifest).toMatchObject({
      kind: 'List',
      items: expect.arrayContaining([
        expect.objectContaining({
          kind: 'ConfigMap',
          immutable: true,
          binaryData: { 'index.html': bytes.toString('base64') },
        }),
        expect.objectContaining({
          kind: 'Service',
          spec: expect.objectContaining({ type: 'ClusterIP' }),
        }),
      ]),
    });
    expect(() => renderManifest(bytes, receipt, 'nginx:latest')).toThrow();
  });
});
