import { describe, expect, it } from 'vitest';
import * as adapters from '../src/index.ts';

const scope = {
  sourceId: '14026b3a-1955-4b55-aeb0-eabf926b4614',
  workspaceId: '24026b3a-1955-4b55-aeb0-eabf926b4614',
  serviceId: '34026b3a-1955-4b55-aeb0-eabf926b4614',
  instance: 'sandbox',
  applicationUid: 'app-uid',
  applicationName: 'guestbook',
  applicationNamespace: 'argocd',
  project: 'default',
  destinationClusterId: 'cluster-1',
  destinationServer: 'https://kubernetes.default.svc',
  destinationName: null,
  destinationNamespace: 'guestbook',
  configurationRepositoryId: 'config-repo',
  repoURL: 'https://example.test/config.git',
  environment: 'production',
};
function fixture() {
  return {
    contract: 'clio.argocd.notification.v1',
    application: {
      uid: 'app-uid',
      name: 'guestbook',
      namespace: 'argocd',
      project: 'default',
      destination: { server: scope.destinationServer, name: null, namespace: 'guestbook' },
      repoURL: scope.repoURL,
      hasSources: false,
      hasSourceHydrator: false,
    },
    operation: {
      phase: 'Succeeded',
      startedAt: '2026-10-10T10:00:00Z',
      finishedAt: '2026-10-10T10:00:02Z',
      retryCount: 0,
      info: [
        { name: 'clio.operation-id', value: 'a4026b3a-1955-4b55-aeb0-eabf926b4614' },
        { name: 'clio.operation-kind', value: 'rollout' },
      ],
      initiatedBy: { username: 'operator', automated: false },
      revision: 'opaque/config-v1',
      revisions: [],
    },
    health: { status: 'Healthy', lastTransitionTime: '2026-10-10T10:00:05Z' },
  };
}
const observed = '2026-10-10T10:01:00.123456Z';
function parse(input: unknown = fixture(), at = observed) {
  expect(adapters.parseArgoNotification).toBeTypeOf('function');
  return adapters.parseArgoNotification(input, scope, at);
}
function operation(input: unknown = fixture(), at = observed) {
  const result = parse(input, at);
  expect(result.kind).toBe('operation');
  if (result.kind !== 'operation') throw new Error('Expected operation');
  return result;
}
describe('native Argo notification boundary', () => {
  it('keeps separate operations at one opaque configuration revision with no exposure or application commit', () => {
    const first = operation();
    const next = fixture();
    next.operation.info[0] = {
      name: 'clio.operation-id',
      value: 'b4026b3a-1955-4b55-aeb0-eabf926b4614',
    };
    const second = operation(next);
    expect(first.evidence.deployments[0]?.id).not.toBe(second.evidence.deployments[0]?.id);
    expect(first.evidence.deployments[0]).toMatchObject({
      repository: null,
      revision: 'v1',
      operationKind: 'rollout',
      reconciledConfigurationRevision: 'opaque/config-v1',
    });
    expect(first.evidence.statuses[0]).toMatchObject({
      consumerExposure: false,
      eventAt: '2026-10-10T10:00:05Z',
    });
  });
  it('canonicalizes key ordering and excludes trusted observation time from replay identity', () => {
    const input = fixture();
    const reordered = {
      health: input.health,
      operation: input.operation,
      application: input.application,
      contract: input.contract,
    };
    expect(operation(reordered).digest).toBe(operation(input).digest);
    expect(operation(input, '2026-10-10T10:02:00Z').digest).toBe(operation(input).digest);
    expect(adapters.argoNotificationDigest(input, scope)).toBe(operation(input).digest);
    expect(adapters.argoNotificationDigest(input, scope)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(operation(input).canonicalJson)).toHaveProperty(
      'scope.sourceId',
      scope.sourceId,
    );
  });
  it('keeps metadata immutable across status updates, changes it on UUID reuse with conflicting metadata', () => {
    const first = operation();
    const changed = fixture();
    changed.health.status = 'Degraded';
    changed.operation.retryCount = 1;
    const next = operation(changed);
    expect(next.operationMetadataDigest).toBe(first.operationMetadataDigest);
    expect(next.notificationRevision).not.toBe(first.notificationRevision);
    changed.operation.revision = 'another-config';
    expect(operation(changed).operationMetadataDigest).not.toBe(first.operationMetadataDigest);
    changed.operation.revision = fixture().operation.revision;
    changed.operation.info[1] = { name: 'clio.operation-kind', value: 'retry' };
    expect(operation(changed).operationMetadataDigest).not.toBe(first.operationMetadataDigest);
  });
  it('uses later completion time when health predates operation and accepts equal timestamps', () => {
    const input = fixture();
    input.health.lastTransitionTime = '2026-10-09T10:00:00Z';
    expect(operation(input).evidence.statuses[0]?.eventAt).toBe('2026-10-10T10:00:02Z');
    input.health.lastTransitionTime = input.operation.finishedAt;
    expect(operation(input).evidence.statuses[0]?.eventAt).toBe('2026-10-10T10:00:02Z');
  });
  it('preserves safe JSON strings and missing operation kind stays unknown', () => {
    const input = fixture();
    input.operation.initiatedBy.username = 'quote"\\\n<&>';
    input.operation.info.pop();
    expect(operation(input).evidence.deployments[0]?.operationKind).toBe('unknown');
    expect(
      JSON.parse(operation(input).canonicalJson).notification.operation.initiatedBy.username,
    ).toBe('quote"\\\n<&>');
  });
  const gaps: [string, (input: ReturnType<typeof fixture>) => void, string][] = [
    [
      'missing UUID',
      (i) => {
        i.operation.info = [];
      },
      'unmarked_operation',
    ],
    [
      'malformed UUID',
      (i) => {
        i.operation.info[0] = { name: 'clio.operation-id', value: 'bad' };
      },
      'invalid_operation_info',
    ],
    [
      'duplicate info',
      (i) => {
        i.operation.info.push({
          name: 'clio.operation-id',
          value: 'a4026b3a-1955-4b55-aeb0-eabf926b4614',
        });
      },
      'invalid_operation_info',
    ],
    [
      'bad kind',
      (i) => {
        i.operation.info[1] = { name: 'clio.operation-kind', value: 'deployment' };
      },
      'invalid_operation_info',
    ],
    [
      'running',
      (i) => {
        i.operation.phase = 'Running';
      },
      'non_terminal',
    ],
    [
      'multi source',
      (i) => {
        i.application.hasSources = true;
      },
      'multi_source',
    ],
    [
      'hydrator',
      (i) => {
        i.application.hasSourceHydrator = true;
      },
      'source_hydrator',
    ],
    [
      'future health',
      (i) => {
        i.health.lastTransitionTime = '2026-10-10T10:01:00.123457Z';
      },
      'future_timestamp',
    ],
  ];
  it.each(gaps)('records explicit gap for %s', (_name, change, reason) => {
    const input = fixture();
    change(input);
    expect(parse(input)).toMatchObject({
      kind: 'gap',
      reason,
      startedAt: input.operation.startedAt,
    });
    expect(parse(input)).not.toHaveProperty('evidence');
  });
  it.each(['hasSources', 'hasSourceHydrator'] as const)(
    'records real native nullable repository %s gaps while enforcing all other scope fields',
    (mode) => {
      const input = fixture();
      const application = { ...input.application, repoURL: null, [mode]: true };
      expect(parse({ ...input, application })).toMatchObject({
        kind: 'gap',
        reason: mode === 'hasSources' ? 'multi_source' : 'source_hydrator',
      });
      for (const repoURL of [null, 'https://foreign.test/repo.git']) {
        for (const field of ['uid', 'name', 'namespace', 'project'] as const) {
          expect(() =>
            parse({ ...input, application: { ...application, repoURL, [field]: 'foreign' } }),
          ).toThrow('argo_scope_drift');
        }
        for (const field of ['server', 'name', 'namespace'] as const) {
          expect(() =>
            parse({
              ...input,
              application: {
                ...application,
                repoURL,
                destination: { ...application.destination, [field]: 'foreign' },
              },
            }),
          ).toThrow('argo_scope_drift');
        }
      }
      expect(() =>
        parse({
          ...input,
          application: { ...application, repoURL: 'https://foreign.test/repo.git' },
        }),
      ).toThrow('argo_scope_drift');
      expect(() =>
        parse({ ...input, application: { ...input.application, repoURL: null } }),
      ).toThrow('argo_scope_drift');
    },
  );
  it.each(['unmarked', 'multi_source', 'hydrator', 'running'] as const)(
    'nulls future gap start for %s without changing original canonical metadata',
    (mode) => {
      const input = fixture();
      input.operation.startedAt = '2026-10-10T10:02:00Z';
      input.operation.finishedAt = '2026-10-10T10:02:02Z';
      if (mode === 'unmarked') input.operation.info = [];
      if (mode === 'multi_source') input.application.hasSources = true;
      if (mode === 'hydrator') input.application.hasSourceHydrator = true;
      if (mode === 'running') input.operation.phase = 'Running';
      const result = parse(input);
      expect(result).toMatchObject({ kind: 'gap', startedAt: null });
      expect(JSON.parse(result.canonicalJson).notification.operation.startedAt).toBe(
        input.operation.startedAt,
      );
      expect(result.digest).toBe(adapters.argoNotificationDigest(input, scope));
      expect(parse(input, '2026-10-10T10:03:00Z')).toMatchObject({
        kind: 'gap',
        startedAt: input.operation.startedAt,
        digest: result.digest,
      });
    },
  );
  it.each([false, true])(
    'rejects unknown health and malformed native times before gap decisions (unmarked=%s)',
    (unmarked) => {
      const input = fixture();
      if (unmarked) input.operation.info = [];
      expect(() => parse({ ...input, health: { ...input.health, status: 'foreign' } })).toThrow(
        'invalid_argo_notification',
      );
      expect(() =>
        parse({ ...input, operation: { ...input.operation, finishedAt: 'bad' } }),
      ).toThrow(adapters.AdapterError);
      expect(() =>
        parse({ ...input, operation: { ...input.operation, finishedAt: '2026-10-10T09:59:59Z' } }),
      ).toThrow(adapters.AdapterError);
    },
  );
  it('allows exact ten minute horizon and rejects first arrival one microsecond later without blocking replay digest', () => {
    expect(operation(fixture(), '2026-10-10T10:10:02Z').kind).toBe('operation');
    expect(parse(fixture(), '2026-10-10T10:10:02.000001Z')).toMatchObject({
      kind: 'gap',
      reason: 'observation_horizon',
    });
    expect(adapters.argoNotificationDigest(fixture(), scope)).toBe(operation().digest);
  });
  it.each([
    { ...fixture(), unexpected: 'secret' },
    { ...fixture(), operation: { ...fixture().operation, observedAt: observed } },
    { ...fixture(), application: { ...fixture().application, uid: 'foreign' } },
    { ...fixture(), application: { ...fixture().application, project: 'foreign' } },
    { ...fixture(), application: { ...fixture().application, repoURL: 'foreign' } },
    { ...fixture(), operation: { ...fixture().operation, retryCount: -1 } },
    { ...fixture(), operation: { ...fixture().operation, retryCount: 0.1 } },
    { ...fixture(), health: { status: 'Healthy', lastTransitionTime: '2026-02-30T10:00:00Z' } },
    { ...fixture(), operation: { ...fixture().operation, finishedAt: '2026-10-10T09:59:59Z' } },
    {
      ...fixture(),
      operation: {
        ...fixture().operation,
        info: Array.from({ length: 101 }, () => ({ name: 'x', value: 'x' })),
      },
    },
    { ...fixture(), operation: { ...fixture().operation, revision: 'x'.repeat(4097) } },
    null,
  ])('rejects malformed or drifted input with redacted error', (input) => {
    expect(() => parse(input)).toThrow(adapters.AdapterError);
    try {
      parse(input);
    } catch (error) {
      expect(String(error)).not.toContain('secret');
    }
  });
  it('handles nullable native fields as gaps, never fabricated deployments', () => {
    const input = fixture();
    expect(parse({ ...input, operation: { ...input.operation, revision: null } })).toMatchObject({
      kind: 'gap',
      reason: 'missing_sync_result',
    });
    expect(
      parse({ ...input, health: { ...input.health, lastTransitionTime: null } }),
    ).toMatchObject({ kind: 'gap', reason: 'missing_health_timestamp' });
    expect(parse({ ...input, operation: { ...input.operation, finishedAt: null } })).toMatchObject({
      kind: 'gap',
      reason: 'missing_health_timestamp',
    });
    expect(parse({ ...input, operation: { ...input.operation, startedAt: null } })).toMatchObject({
      kind: 'gap',
      reason: 'non_terminal',
    });
  });
  it('rejects drift on every native application binding field', () => {
    const input = fixture();
    for (const field of ['uid', 'name', 'namespace', 'project', 'repoURL'] as const) {
      expect(() =>
        parse({ ...input, application: { ...input.application, [field]: 'foreign' } }),
      ).toThrow(adapters.AdapterError);
    }
    for (const field of ['server', 'name', 'namespace'] as const) {
      expect(() =>
        parse({
          ...input,
          application: {
            ...input.application,
            destination: { ...input.application.destination, [field]: 'foreign' },
          },
        }),
      ).toThrow(adapters.AdapterError);
    }
  });
  it('canonicalizes info ordering and fractional timestamp padding', () => {
    const first = fixture();
    const reordered = fixture();
    reordered.operation.info.reverse();
    reordered.operation.startedAt = '2026-10-10T10:00:00.000000Z';
    expect(operation(first).digest).toBe(operation(reordered).digest);
  });
  it('keeps private grant extensions outside canonical receipts', () => {
    const extended = {
      ...scope,
      tokenDigest: 'private-token-digest',
      fingerprint: 'private-fingerprint',
    };
    const result = adapters.parseArgoNotification(fixture(), extended, observed);
    expect(result.digest).toBe(operation().digest);
    expect(result.canonicalJson).not.toContain('private');
  });
  it('changes immutable metadata when original initiator or operation info changes', () => {
    const first = operation();
    const changed = fixture();
    changed.operation.initiatedBy.username = 'another-actor';
    expect(operation(changed).operationMetadataDigest).not.toBe(first.operationMetadataDigest);
    changed.operation.initiatedBy.username = 'operator';
    changed.operation.info.push({ name: 'automation-run', value: 'another-run' });
    expect(operation(changed).operationMetadataDigest).not.toBe(first.operationMetadataDigest);
  });
  it('rejects unknown nested keys, missing keys, booleans disguised as strings, offsets and excessive payloads', () => {
    const input = fixture();
    const { contract: _contract, ...missing } = input;
    const malformed = [
      missing,
      {
        ...input,
        application: {
          ...input.application,
          destination: { ...input.application.destination, extra: true },
        },
      },
      {
        ...input,
        operation: {
          ...input.operation,
          initiatedBy: { ...input.operation.initiatedBy, extra: true },
        },
      },
      {
        ...input,
        operation: { ...input.operation, info: [{ name: 'x', value: 'x', extra: true }] },
      },
      { ...input, application: { ...input.application, hasSources: 'false' } },
      { ...input, operation: { ...input.operation, startedAt: '2026-10-10T10:00:00+00:00' } },
      {
        ...input,
        operation: {
          ...input.operation,
          info: Array.from({ length: 20 }, (_, n) => ({
            name: String(n),
            value: 'x'.repeat(4096),
          })),
        },
      },
    ];
    for (const invalid of malformed) expect(() => parse(invalid)).toThrow(adapters.AdapterError);
  });
  it('keeps future and malformed observations distinct, with terminal failure support and native health gaps', () => {
    const input = fixture();
    input.operation.phase = 'Failed';
    expect(operation(input).phase).toBe('Failed');
    expect(parse(input, '2026-10-10T10:00:01Z')).toMatchObject({
      kind: 'gap',
      reason: 'future_timestamp',
    });
    expect(() => parse(input, 'not-a-time')).toThrow(adapters.AdapterError);
    expect(parse({ ...input, health: { status: null, lastTransitionTime: null } })).toMatchObject({
      kind: 'gap',
      reason: 'missing_health_timestamp',
    });
    expect(
      parse({ ...input, operation: { ...input.operation, revisions: ['one', 'two'] } }),
    ).toMatchObject({ kind: 'gap', reason: 'multi_source' });
  });
});
