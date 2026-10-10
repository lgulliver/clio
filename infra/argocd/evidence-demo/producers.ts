import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const limit = 64 * 1024;
export const buildPolicy = 'urn:clio:sandbox:git-artifact-build:v1';
export const exposurePolicy = 'urn:clio:sandbox:http-artifact:v1';
function fail(): never {
  throw new Error('invalid_demo_evidence');
}
function row(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  const result = Object.fromEntries(Object.entries(value));
  if (Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
    fail();
  return result;
}
function text(value: unknown, max = 2048): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    value.length > max ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    fail();
  return value;
}
function uuid(value: unknown): string {
  const result = text(value).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result))
    fail();
  return result;
}
function utcInstant(value: unknown): bigint {
  const result = text(value);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(result);
  if (!match?.[1]) fail();
  const milliseconds = Date.parse(result);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 19) !== match[1]
  )
    fail();
  return BigInt(milliseconds) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0').slice(3));
}
function sha(value: unknown): string {
  const result = text(value);
  if (!/^[0-9a-f]{40}$/.test(result)) fail();
  return result;
}
function digest(value: unknown): string {
  const result = text(value);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) fail();
  return result;
}
export function artifactDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
export interface BuildReceipt {
  contract: 'clio.sandbox.git-artifact.v1';
  repository_id: string;
  commit_sha: string;
  artifact_digest: string;
  source_path: string;
}
export function parseReceipt(value: unknown): BuildReceipt {
  const data = row(value, [
    'contract',
    'repository_id',
    'commit_sha',
    'artifact_digest',
    'source_path',
  ]);
  const repositoryId = text(data.repository_id);
  if (
    data.contract !== 'clio.sandbox.git-artifact.v1' ||
    !/^[^:\s]+:.+/.test(repositoryId) ||
    data.source_path !== 'infra/argocd/evidence-demo/app/index.html'
  )
    fail();
  return {
    contract: 'clio.sandbox.git-artifact.v1',
    repository_id: repositoryId,
    commit_sha: sha(data.commit_sha),
    artifact_digest: digest(data.artifact_digest),
    source_path: data.source_path,
  };
}
function checkArtifact(bytes: Uint8Array, receipt: BuildReceipt): void {
  if (!bytes.length || bytes.length > limit || artifactDigest(bytes) !== receipt.artifact_digest)
    fail();
  new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export async function buildArtifact(input: {
  gitDirectory: string;
  commitSha: string;
  repositoryId: string;
  outputDirectory: string;
}): Promise<BuildReceipt> {
  const commitSha = sha(input.commitSha);
  const sourcePath = 'infra/argocd/evidence-demo/app/index.html';
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  const type = await exec('git', ['-C', input.gitDirectory, 'cat-file', '-t', commitSha], {
    maxBuffer: 1024,
    env,
  });
  if (type.stdout.trim() !== 'commit') fail();
  const tree = await exec(
    'git',
    ['-C', input.gitDirectory, 'ls-tree', commitSha, '--', sourcePath],
    { maxBuffer: 4096, env },
  );
  if (!/^(100644|100755) blob [0-9a-f]{40}\t/.test(tree.stdout)) fail();
  // Git reads immutable committed bytes, never a dirty worktree file.
  const { stdout } = await exec(
    'git',
    ['-C', input.gitDirectory, 'show', `${commitSha}:${sourcePath}`],
    { encoding: 'buffer', maxBuffer: limit, env },
  );
  const receipt = parseReceipt({
    contract: 'clio.sandbox.git-artifact.v1',
    repository_id: input.repositoryId,
    commit_sha: commitSha,
    artifact_digest: artifactDigest(stdout),
    source_path: sourcePath,
  });
  checkArtifact(stdout, receipt);
  await mkdir(input.outputDirectory, { recursive: false, mode: 0o700 });
  await writeFile(join(input.outputDirectory, 'index.html'), stdout, { flag: 'wx', mode: 0o600 });
  await writeFile(
    join(input.outputDirectory, 'build-receipt.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return receipt;
}
export async function readArtifact(directory: string) {
  const receipt = parseReceipt(await readJson(join(directory, 'build-receipt.json')));
  const artifactPath = join(directory, 'index.html');
  const stat = await lstat(artifactPath);
  if (!stat.isFile() || stat.size > limit) fail();
  const bytes = await readFile(artifactPath);
  checkArtifact(bytes, receipt);
  return { receipt, bytes };
}
export async function readJson(path: string): Promise<unknown> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > limit) fail();
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  return value;
}
export interface Producer {
  sourceId: string;
  producerId: string;
}
function common(producer: Producer, kind: 'application_provenance' | 'consumer_exposure') {
  const eventId = randomUUID();
  return {
    contract: 'clio.argocd.enrichment.v1',
    event_id: eventId,
    source_id: uuid(producer.sourceId),
    producer_id: uuid(producer.producerId),
    policy_reference: kind === 'application_provenance' ? buildPolicy : exposurePolicy,
    evidence_ref: `urn:clio:sandbox:${kind}:${eventId}`,
    kind,
  };
}
export function provenanceEvent(bytes: Uint8Array, unknownReceipt: unknown, producer: Producer) {
  const receipt = parseReceipt(unknownReceipt);
  checkArtifact(bytes, receipt);
  return {
    ...common(producer, 'application_provenance'),
    kind: 'application_provenance',
    repository_id: receipt.repository_id,
    commit_sha: receipt.commit_sha,
    artifact_digest: receipt.artifact_digest,
  };
}
function operationBinding(value: unknown) {
  const notification = row(value, ['contract', 'application', 'operation', 'health']);
  if (notification.contract !== 'clio.argocd.notification.v1') fail();
  const application = row(notification.application, [
    'uid',
    'name',
    'namespace',
    'project',
    'destination',
    'repoURL',
    'hasSources',
    'hasSourceHydrator',
  ]);
  const operation = row(notification.operation, [
    'phase',
    'startedAt',
    'finishedAt',
    'retryCount',
    'info',
    'initiatedBy',
    'revision',
    'revisions',
  ]);
  if (
    application.hasSources !== false ||
    application.hasSourceHydrator !== false ||
    !Array.isArray(operation.revisions) ||
    operation.revisions.length ||
    operation.retryCount !== 0 ||
    !Array.isArray(operation.info) ||
    operation.info.length > 100
  )
    fail();
  const infos = operation.info.map((value) => {
    const info = row(value, ['name', 'value']);
    return { name: text(info.name), value: text(info.value) };
  });
  if (
    new Set(infos.map((info) => info.name)).size !== infos.length ||
    infos.find((info) => info.name === 'clio.operation-kind')?.value !== 'rollout'
  )
    fail();
  const startedAt = text(operation.startedAt);
  utcInstant(startedAt);
  return {
    application_uid: text(application.uid, 200),
    operation_id: uuid(infos.find((info) => info.name === 'clio.operation-id')?.value),
    configuration_revision: text(operation.revision, 200),
    startedAt,
  };
}
function kubeObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
  return Object.fromEntries(Object.entries(value));
}
function optionalObject(value: unknown): Record<string, unknown> {
  return value === undefined || value === null ? {} : kubeObject(value);
}
function nullableText(value: unknown): string | null {
  return value === undefined || value === null || value === '' ? null : text(value, 4096);
}
function nullableTime(value: unknown): string | null {
  const result = nullableText(value);
  if (result !== null) utcInstant(result);
  return result;
}
/** Selects actual Kubernetes fields into the notification template contract; never generates identity. */
export function nativeNotification(value: unknown) {
  const application = kubeObject(value);
  if (application.kind !== 'Application' || application.apiVersion !== 'argoproj.io/v1alpha1')
    fail();
  const metadata = kubeObject(application.metadata);
  const spec = kubeObject(application.spec);
  const status = kubeObject(application.status);
  const destination = kubeObject(spec.destination);
  const source = optionalObject(spec.source);
  const state = kubeObject(status.operationState);
  const operation = kubeObject(state.operation);
  const initiator = optionalObject(operation.initiatedBy);
  const syncResult = optionalObject(state.syncResult);
  const health = optionalObject(status.health);
  const info = operation.info ?? [];
  if (!Array.isArray(info) || info.length > 100) fail();
  const infos = info.map((value) => {
    const entry = kubeObject(value);
    return { name: text(entry.name, 4096), value: text(entry.value, 4096) };
  });
  if (
    new Set(infos.map((entry) => entry.name)).size !== infos.length ||
    infos.find((entry) => entry.name === 'clio.operation-kind')?.value !== 'rollout'
  )
    fail();
  uuid(infos.find((entry) => entry.name === 'clio.operation-id')?.value);
  const retryCount = state.retryCount ?? 0;
  if (typeof retryCount !== 'number' || !Number.isSafeInteger(retryCount) || retryCount < 0) fail();
  const automated = initiator.automated ?? false;
  if (typeof automated !== 'boolean') fail();
  const revisions = syncResult.revisions ?? [];
  if (!Array.isArray(revisions) || revisions.length > 100) fail();
  const healthStatus = nullableText(health.status);
  if (
    healthStatus !== null &&
    !['Healthy', 'Progressing', 'Degraded', 'Suspended', 'Missing', 'Unknown'].includes(
      healthStatus,
    )
  )
    fail();
  const startedAt = nullableTime(state.startedAt);
  const finishedAt = nullableTime(state.finishedAt);
  if (startedAt !== null && finishedAt !== null && utcInstant(finishedAt) < utcInstant(startedAt))
    fail();
  const result = {
    contract: 'clio.argocd.notification.v1',
    application: {
      uid: text(metadata.uid, 4096),
      name: text(metadata.name, 4096),
      namespace: text(metadata.namespace, 4096),
      project: text(spec.project, 4096),
      destination: {
        server: nullableText(destination.server),
        name: nullableText(destination.name),
        namespace: text(destination.namespace, 4096),
      },
      repoURL: nullableText(source.repoURL),
      hasSources: Object.hasOwn(spec, 'sources'),
      hasSourceHydrator: Object.hasOwn(spec, 'sourceHydrator'),
    },
    operation: {
      phase: nullableText(state.phase),
      startedAt,
      finishedAt,
      retryCount,
      info: infos,
      initiatedBy: { username: nullableText(initiator.username), automated },
      revision: nullableText(syncResult.revision),
      revisions: revisions.map((value) => text(value, 4096)),
    },
    health: { status: healthStatus, lastTransitionTime: nullableTime(health.lastTransitionTime) },
  };
  if (Buffer.byteLength(JSON.stringify(result)) > limit) fail();
  return result;
}
export async function saveNativeNotification(
  applicationFile: string,
  outputFile: string,
  expectedOperationId?: string,
): Promise<void> {
  const result = nativeNotification(await readJson(applicationFile));
  if (
    expectedOperationId !== undefined &&
    uuid(result.operation.info.find((entry) => entry.name === 'clio.operation-id')?.value) !==
      uuid(expectedOperationId)
  )
    fail();
  await writeFile(outputFile, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
export function loopbackUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    fail();
  return url;
}
async function boundedBody(response: Response): Promise<Uint8Array> {
  if (!response.body) fail();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > limit) fail();
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
function rejectProxyEnvironment(): void {
  if (
    Object.entries(process.env).some(
      ([name, value]) =>
        value &&
        (['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'].includes(name.toUpperCase()) ||
          (name === 'NODE_USE_ENV_PROXY' && value !== '0')),
    )
  )
    fail();
}
export function parseBaseline(value: unknown) {
  const data = row(value, [
    'contract',
    'operation_id',
    'endpoint',
    'observed_at',
    'http_status',
    'artifact_digest',
    'byte_count',
  ]);
  if (
    data.contract !== 'clio.sandbox.http-baseline.v1' ||
    (data.http_status !== 200 && data.http_status !== 404) ||
    typeof data.byte_count !== 'number' ||
    !Number.isSafeInteger(data.byte_count) ||
    data.byte_count < 0 ||
    data.byte_count > limit
  )
    fail();
  const endpoint = loopbackUrl(text(data.endpoint));
  if (endpoint.pathname !== '/index.html') fail();
  const observedAt = text(data.observed_at);
  utcInstant(observedAt);
  return {
    contract: 'clio.sandbox.http-baseline.v1',
    operation_id: uuid(data.operation_id),
    endpoint: endpoint.href,
    observed_at: observedAt,
    http_status: data.http_status,
    artifact_digest: digest(data.artifact_digest),
    byte_count: data.byte_count,
  };
}
/** Capture before initiating the rollout; this command never accepts a supplied timestamp. */
export async function captureBaseline(
  endpoint: string,
  operationId: string,
  fetcher: typeof fetch = fetch,
) {
  const normalizedId = uuid(operationId);
  rejectProxyEnvironment();
  const url = loopbackUrl(endpoint);
  if (url.pathname !== '/index.html') fail();
  const response = await fetcher(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { 'Accept-Encoding': 'identity' },
  });
  if (
    ![200, 404].includes(response.status) ||
    response.redirected ||
    (response.headers.get('content-encoding') &&
      response.headers.get('content-encoding') !== 'identity')
  )
    fail();
  const bytes = response.body === null ? new Uint8Array() : await boundedBody(response);
  return parseBaseline({
    contract: 'clio.sandbox.http-baseline.v1',
    operation_id: normalizedId,
    endpoint: url.href,
    observed_at: new Date().toISOString(),
    http_status: response.status,
    artifact_digest: artifactDigest(bytes),
    byte_count: bytes.length,
  });
}
export async function saveBaseline(
  endpoint: string,
  operationId: string,
  outputFile: string,
): Promise<void> {
  const baseline = await captureBaseline(endpoint, operationId);
  await writeFile(outputFile, `${JSON.stringify(baseline, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}
export async function observeArtifact(
  input: {
    endpoint: string;
    bytes: Uint8Array;
    receipt: unknown;
    notification: unknown;
    baseline: unknown;
    producer: Producer;
  },
  fetcher: typeof fetch = fetch,
) {
  rejectProxyEnvironment();
  const receipt = parseReceipt(input.receipt);
  checkArtifact(input.bytes, receipt);
  const binding = operationBinding(input.notification);
  const url = loopbackUrl(input.endpoint);
  if (url.pathname !== '/index.html') fail();
  const baseline = parseBaseline(input.baseline);
  if (
    baseline.endpoint !== url.href ||
    baseline.operation_id !== binding.operation_id ||
    utcInstant(baseline.observed_at) >= utcInstant(binding.startedAt) ||
    (baseline.http_status === 200 && baseline.artifact_digest === receipt.artifact_digest)
  )
    fail();
  const response = await fetcher(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { 'Accept-Encoding': 'identity' },
  });
  if (
    response.status !== 200 ||
    response.redirected ||
    (response.headers.get('content-encoding') &&
      response.headers.get('content-encoding') !== 'identity')
  )
    fail();
  const observed = await boundedBody(response);
  if (!Buffer.from(observed).equals(Buffer.from(input.bytes))) fail();
  const effectiveAt = new Date().toISOString();
  if (utcInstant(binding.startedAt) > utcInstant(effectiveAt)) fail();
  const { startedAt: _startedAt, ...subjectBinding } = binding;
  const event = {
    ...common(input.producer, 'consumer_exposure'),
    kind: 'consumer_exposure',
    ...subjectBinding,
    effective_at: effectiveAt,
    subject: { kind: 'artifact', digest: receipt.artifact_digest },
  };
  const observation = {
    contract: 'clio.sandbox.http-observation.v1',
    event_id: event.event_id,
    endpoint: url.href,
    observed_at: effectiveAt,
    artifact_digest: receipt.artifact_digest,
    byte_count: observed.length,
    policy_reference: exposurePolicy,
    baseline,
  };
  return { event, observation };
}
export async function saveEvidence(
  directory: string,
  event: unknown,
  observation?: unknown,
): Promise<void> {
  await mkdir(directory, { recursive: false, mode: 0o700 });
  if (observation)
    await writeFile(
      join(directory, 'observation.json'),
      `${JSON.stringify(observation, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
  // Observation persistence must succeed before a publishable event appears.
  await writeFile(join(directory, 'event.json'), `${JSON.stringify(event, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}
export async function publishEvidence(
  input: { baseUrl: string; event: unknown; tokenFile: string },
  fetcher: typeof fetch = fetch,
): Promise<number> {
  rejectProxyEnvironment();
  const event = row(input.event, [
    'contract',
    'event_id',
    'source_id',
    'producer_id',
    'policy_reference',
    'evidence_ref',
    'kind',
    ...(Object.hasOwn(Object(input.event), 'subject')
      ? ['application_uid', 'operation_id', 'configuration_revision', 'effective_at', 'subject']
      : ['repository_id', 'commit_sha', 'artifact_digest']),
  ]);
  if (
    event.contract !== 'clio.argocd.enrichment.v1' ||
    !['consumer_exposure', 'application_provenance'].includes(text(event.kind))
  )
    fail();
  uuid(event.event_id);
  text(event.evidence_ref, 200);
  if (event.kind === 'application_provenance') {
    if (event.policy_reference !== buildPolicy || !/^[^:\s]+:.+/.test(text(event.repository_id)))
      fail();
    sha(event.commit_sha);
    digest(event.artifact_digest);
  } else {
    if (event.policy_reference !== exposurePolicy) fail();
    text(event.application_uid, 200);
    uuid(event.operation_id);
    text(event.configuration_revision, 200);
    utcInstant(event.effective_at);
    const subject = row(event.subject, ['kind', 'digest']);
    if (subject.kind !== 'artifact') fail();
    digest(subject.digest);
  }
  const base = loopbackUrl(input.baseUrl);
  if (base.pathname !== '/') fail();
  const url = new URL(
    `/api/argo/sources/${uuid(event.source_id)}/enrichments/${uuid(event.producer_id)}`,
    base,
  );
  return sendPrivateBody(JSON.stringify(event), url, input.tokenFile, fetcher);
}
export async function publishNative(
  input: { notification: unknown; baseUrl: string; sourceId: string; tokenFile: string },
  fetcher: typeof fetch = fetch,
): Promise<number> {
  operationBinding(input.notification);
  const base = loopbackUrl(input.baseUrl);
  if (base.pathname !== '/') fail();
  const url = new URL(`/api/argo/sources/${uuid(input.sourceId)}/operations`, base);
  return sendPrivateBody(JSON.stringify(input.notification), url, input.tokenFile, fetcher);
}
async function sendPrivateBody(
  body: string,
  url: URL,
  tokenFile: string,
  fetcher: typeof fetch,
): Promise<number> {
  rejectProxyEnvironment();
  if (!isAbsolute(tokenFile)) fail();
  if ((await realpath(tokenFile)) !== tokenFile) fail();
  for (let directory = dirname(tokenFile); ; ) {
    const gitEntry = await lstat(join(directory, '.git')).then(
      () => true,
      (error) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
        throw error;
      },
    );
    if (gitEntry) fail();
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const file = await open(
    tokenFile,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let token: string;
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.uid !== process.getuid?.() ||
      stat.size > 4096
    )
      fail();
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) fail();
    token = buffer.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await file.close();
  }
  if (!/^[0-9a-f]{64}$/.test(token)) fail();
  if (Buffer.byteLength(body) > limit) fail();
  const response = await fetcher(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body,
  });
  await response.body?.cancel();
  // Status only: never forward private receiver errors or alter the persisted event.
  return response.status;
}
export function renderManifest(
  bytes: Uint8Array,
  unknownReceipt: unknown,
  nginxImage: string,
): string {
  const receipt = parseReceipt(unknownReceipt);
  checkArtifact(bytes, receipt);
  if (!/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(nginxImage)) fail();
  const name = `artifact-${receipt.artifact_digest.slice(7)}`;
  const namespace = 'clio-evidence-demo';
  return JSON.stringify(
    {
      apiVersion: 'v1',
      kind: 'List',
      items: [
        { apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } },
        {
          apiVersion: 'v1',
          kind: 'ConfigMap',
          metadata: { name, namespace },
          immutable: true,
          binaryData: { 'index.html': Buffer.from(bytes).toString('base64') },
        },
        {
          apiVersion: 'apps/v1',
          kind: 'Deployment',
          metadata: { name: 'sandbox-consumer', namespace },
          spec: {
            replicas: 1,
            selector: { matchLabels: { app: 'sandbox-consumer' } },
            template: {
              metadata: {
                labels: { app: 'sandbox-consumer' },
                annotations: { 'clio.artifact-digest': receipt.artifact_digest },
              },
              spec: {
                containers: [
                  {
                    name: 'http',
                    image: nginxImage,
                    ports: [{ containerPort: 80 }],
                    volumeMounts: [
                      {
                        name: 'artifact',
                        mountPath: '/usr/share/nginx/html/index.html',
                        subPath: 'index.html',
                        readOnly: true,
                      },
                    ],
                  },
                ],
                volumes: [{ name: 'artifact', configMap: { name } }],
              },
            },
          },
        },
        {
          apiVersion: 'v1',
          kind: 'Service',
          metadata: { name: 'sandbox-consumer', namespace },
          spec: {
            type: 'ClusterIP',
            selector: { app: 'sandbox-consumer' },
            ports: [{ port: 80, targetPort: 80 }],
          },
        },
      ],
    },
    null,
    2,
  );
}
