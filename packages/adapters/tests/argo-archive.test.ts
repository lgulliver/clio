import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as adapters from '../src/index.ts';

const zero = '0'.repeat(64);
const startup = '2026-10-10T10:00:00Z';
const captured = '2026-10-10T10:01:00.123456Z';
const received = '2026-10-11T12:00:00.654321Z';
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
function notification() {
  return {
    contract: 'clio.argocd.notification.v1',
    application: {
      uid: scope.applicationUid,
      name: scope.applicationName,
      namespace: scope.applicationNamespace,
      project: scope.project,
      destination: { server: scope.destinationServer, name: null, namespace: 'guestbook' },
      repoURL: scope.repoURL,
      hasSources: false,
      hasSourceHydrator: false,
    },
    operation: {
      phase: 'Succeeded',
      startedAt: startup,
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
function common() {
  return {
    contract: 'clio.argocd.archive.v1',
    source_id: scope.sourceId,
    producer_id: '44026b3a-1955-4b55-aeb0-eabf926b4614',
    journal_id: '54026b3a-1955-4b55-aeb0-eabf926b4614',
    policy_reference: 'fictional-original-observations-v1',
    startup_at: startup,
    evidence_ref: 'fictional-retained-proof',
  };
}
function entry() {
  return {
    ...common(),
    kind: 'entry',
    sequence: 1,
    previous_digest: zero,
    captured_at: captured,
    notification: notification(),
  };
}
function seal() {
  return {
    ...common(),
    kind: 'seal',
    seal_id: '64026b3a-1955-4b55-aeb0-eabf926b4614',
    start: startup,
    end: '2026-10-10T11:00:00Z',
    first_sequence: 1,
    last_sequence: 0,
    entry_count: 0,
    last_digest: zero,
    interruptions: [],
  };
}
function signed<T extends object>(value: T) {
  expect(adapters.archiveRecordDigest).toBeTypeOf('function');
  return { ...value, digest: adapters.archiveRecordDigest(value) };
}
function parse(value: unknown) {
  expect(adapters.parseArchiveRecord).toBeTypeOf('function');
  return adapters.parseArchiveRecord(value);
}
function historical(input: unknown = notification(), capture = captured, receipt = received) {
  expect(adapters.parseHistoricalArgoNotification).toBeTypeOf('function');
  return adapters.parseHistoricalArgoNotification(input, scope, capture, receipt);
}

describe('strict Argo archive records', () => {
  it('accepts entries independently of unsupported native eligibility', () => {
    for (const payload of [notification(), null, 'unsupported', { arbitrary: [1, true] }]) {
      const wire = signed({ ...entry(), notification: payload });
      expect(parse(wire)).toEqual(wire);
    }
  });
  it('hashes recursively sorted keys and preserves arrays, excluding only top-level digest', () => {
    const value = { z: [{ b: 2, a: 1 }], a: { z: false, digest: 'included' } };
    const expected = createHash('sha256')
      .update('{"a":{"digest":"included","z":false},"z":[{"a":1,"b":2}]}')
      .digest('hex');
    expect(adapters.archiveRecordDigest(value)).toBe(expected);
    expect(adapters.archiveRecordDigest({ digest: zero, ...value })).toBe(expected);
    expect(adapters.archiveRecordDigest({ a: value.a, z: value.z })).toBe(expected);
    expect(adapters.archiveRecordDigest({ z: [2, 1] })).not.toBe(
      adapters.archiveRecordDigest({ z: [1, 2] }),
    );
  });
  it('detects payload tampering even when wrapper shape stays valid', () => {
    const wire = signed(entry());
    expect(() => parse({ ...wire, notification: null })).toThrow(adapters.AdapterError);
    expect(() => parse({ ...wire, digest: 'A'.repeat(64) })).toThrow(adapters.AdapterError);
  });
  it.each([
    { extra: 'private-value' },
    { contract: 'unknown' },
    { kind: 'unknown' },
    { sequence: 0 },
    { sequence: -1 },
    { sequence: 1.1 },
    { sequence: Number.MAX_SAFE_INTEGER + 1 },
    { previous_digest: 'f'.repeat(63) },
    { previous_digest: 'f'.repeat(64) },
    { source_id: 'not-uuid' },
    { producer_id: '44026B3A-1955-4B55-AEB0-EABF926B4614' },
    { journal_id: '00000000-0000-0000-0000-000000000000' },
    { startup_at: '2026-02-30T10:00:00Z' },
    { captured_at: '2026-10-10T10:01:00+00:00' },
    { captured_at: '2026-10-10T10:01:00.1234567Z' },
    { captured_at: '2026-10-10T24:01:00Z' },
    { captured_at: '2026-10-10T10:60:00Z' },
    { captured_at: '2026-10-10T09:59:59.999999Z' },
    { policy_reference: '' },
    { evidence_ref: 'x'.repeat(201) },
  ])('rejects invalid entry fields %j', (change) => {
    expect(() => parse(signed({ ...entry(), ...change }))).toThrow(adapters.AdapterError);
  });
  it('bounds references by Unicode codepoints', () => {
    expect(parse(signed({ ...entry(), evidence_ref: '😀'.repeat(200) }))).toHaveProperty(
      'evidence_ref',
      '😀'.repeat(200),
    );
    expect(() => parse(signed({ ...entry(), policy_reference: '😀'.repeat(201) }))).toThrow(
      adapters.AdapterError,
    );
  });
  it('sorts numeric-looking JSON keys lexically and retains signed fractional spelling', () => {
    const expected = createHash('sha256').update('{"10":1,"2":2}').digest('hex');
    expect(adapters.archiveRecordDigest({ '2': 2, '10': 1 })).toBe(expected);
    const wire = signed({ ...entry(), captured_at: '2026-10-10T10:01:00.123450Z' });
    expect(parse(wire)).toHaveProperty('captured_at', '2026-10-10T10:01:00.123450Z');
    expect(() => parse({ ...wire, captured_at: '2026-10-10T10:01:00.12345Z' })).toThrow(
      adapters.AdapterError,
    );
  });
  it('accepts maximum safe sequence and seal integers without rounded range arithmetic', () => {
    expect(
      parse(
        signed({ ...entry(), sequence: Number.MAX_SAFE_INTEGER, previous_digest: 'a'.repeat(64) }),
      ),
    ).toHaveProperty('sequence', Number.MAX_SAFE_INTEGER);
    expect(
      parse(
        signed({
          ...seal(),
          first_sequence: Number.MAX_SAFE_INTEGER,
          last_sequence: Number.MAX_SAFE_INTEGER,
          entry_count: 1,
          last_digest: 'a'.repeat(64),
        }),
      ),
    ).toHaveProperty('entry_count', 1);
    expect(() => parse(signed({ ...seal(), last_sequence: Number.MAX_SAFE_INTEGER + 1 }))).toThrow(
      adapters.AdapterError,
    );
  });
  it('counts entire serialized UTF8 envelope including digest at exact size boundary', () => {
    const base = signed({ ...entry(), notification: '' });
    const remaining = 65536 - Buffer.byteLength(JSON.stringify(base), 'utf8');
    const exact = signed({ ...entry(), notification: 'x'.repeat(remaining) });
    expect(Buffer.byteLength(JSON.stringify(exact), 'utf8')).toBe(65536);
    expect(parse(exact)).toEqual(exact);
    expect(() => parse(signed({ ...entry(), notification: 'x'.repeat(remaining + 1) }))).toThrow(
      adapters.AdapterError,
    );
    expect(() => parse(signed({ ...entry(), notification: '😀'.repeat(remaining) }))).toThrow(
      adapters.AdapterError,
    );
  });
  it('rejects missing fields and non-JSON payloads with redacted errors', () => {
    const { notification: _notification, ...missing } = entry();
    expect(() => parse(signed(missing))).toThrow(adapters.AdapterError);
    for (const payload of [undefined, NaN, Infinity, 1n, () => 'private-value']) {
      expect(() => signed({ ...entry(), notification: payload })).toThrow(adapters.AdapterError);
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => signed({ ...entry(), notification: circular })).toThrow(adapters.AdapterError);
    try {
      parse(signed({ ...entry(), extra: 'private-value' }));
    } catch (error) {
      expect(String(error)).not.toContain('private-value');
    }
  });
  it('accepts empty genesis and later incremental seals, preserving microseconds', () => {
    expect(parse(signed(seal()))).toEqual(signed(seal()));
    const later = signed({
      ...seal(),
      first_sequence: 4,
      last_sequence: 3,
      last_digest: 'a'.repeat(64),
      start: '2026-10-10T10:00:00.000001Z',
    });
    expect(parse(later)).toEqual(later);
    expect(
      parse(signed({ ...seal(), last_sequence: 2, entry_count: 2, last_digest: 'a'.repeat(64) })),
    ).toHaveProperty('entry_count', 2);
  });
  it.each([
    { extra: true },
    { seal_id: 'bad' },
    { first_sequence: 0 },
    { last_sequence: -1 },
    { entry_count: -1 },
    { last_sequence: 2, entry_count: 1 },
    { last_sequence: 1, entry_count: 0 },
    { first_sequence: 3, last_sequence: 0 },
    { last_digest: 'a'.repeat(64) },
    { start: '2026-10-10T09:59:59.999999Z' },
    { end: startup },
    { end: '2026-10-10T09:59:59Z' },
    {
      interruptions: Array.from({ length: 33 }, () => ({
        start: startup,
        end: captured,
        reason: 'gap',
      })),
    },
    { interruptions: [{ start: startup, end: captured, reason: 'gap', extra: true }] },
    { interruptions: [{ start: startup, end: captured, reason: '' }] },
    { interruptions: [{ start: startup, end: captured, reason: 'x'.repeat(201) }] },
    { interruptions: [{ start: '2026-10-10T09:59:59Z', end: captured, reason: 'gap' }] },
    { interruptions: [{ start: startup, end: '2026-10-10T11:00:00.000001Z', reason: 'gap' }] },
    { interruptions: [{ start: startup, end: startup, reason: 'gap' }] },
  ])('rejects contradictory seal fields %j', (change) => {
    expect(() => parse(signed({ ...seal(), ...change }))).toThrow(adapters.AdapterError);
  });
  it('keeps bounded interruption intervals inside seal', () => {
    const interruptions = [
      { start: startup, end: captured, reason: 'receiver unavailable' },
      { start: captured, end: '2026-10-10T10:02:00Z', reason: 'source unavailable' },
    ];
    expect(parse(signed({ ...seal(), interruptions }))).toHaveProperty(
      'interruptions',
      interruptions,
    );
  });
});

describe('historical Argo capture and receiver clocks', () => {
  it('admits old delivery using original horizon while keeping current receiver availability', () => {
    const original = adapters.parseArgoNotification(notification(), scope, captured);
    const result = historical();
    expect(result.kind).toBe('operation');
    if (original.kind !== 'operation' || result.kind !== 'operation')
      throw new Error('Expected operation');
    expect(result).toMatchObject({
      digest: original.digest,
      canonicalJson: original.canonicalJson,
      operationMetadataDigest: original.operationMetadataDigest,
      notificationRevision: original.notificationRevision,
    });
    expect(result.evidence.deployments[0]).toMatchObject({
      observedAt: received,
      eventAt: startup,
    });
    expect(result.evidence.statuses[0]).toMatchObject({
      observedAt: received,
      consumerExposure: false,
    });
    expect(adapters.parseArgoNotification(notification(), scope, received)).toMatchObject({
      kind: 'gap',
      reason: 'observation_horizon',
    });
  });
  it('keeps exact live horizon without widening it for historical capture', () => {
    expect(historical(notification(), '2026-10-10T10:10:02Z').kind).toBe('operation');
    expect(historical(notification(), '2026-10-10T10:10:02.000001Z')).toMatchObject({
      kind: 'gap',
      reason: 'observation_horizon',
    });
    expect(
      adapters.parseArgoNotification(notification(), scope, '2026-10-10T10:10:02.000001Z'),
    ).toMatchObject({ kind: 'gap', reason: 'observation_horizon' });
  });
  it('rejects future capture against receiver clock rather than backdating availability', () => {
    expect(() => historical(notification(), captured, '2026-10-10T10:01:00.123455Z')).toThrow(
      adapters.AdapterError,
    );
    expect(historical(notification(), captured, captured).kind).toBe('operation');
  });
  it('preserves temporal gaps from capture before operation start or terminal health', () => {
    const result = historical(notification(), '2026-10-10T09:59:59.999999Z');
    expect(result).toMatchObject({ kind: 'gap', reason: 'future_timestamp', startedAt: null });
    expect(result.canonicalJson).toBe(
      adapters.parseArgoNotification(notification(), scope, captured).canonicalJson,
    );
    expect(historical(notification(), '2026-10-10T10:00:03Z')).toMatchObject({
      kind: 'gap',
      reason: 'future_timestamp',
    });
  });
  it('keeps unsupported shape and actual scope drift detectable at native boundary', () => {
    expect(() => historical({ unsupported: true })).toThrow('invalid_argo_notification');
    const input = notification();
    for (const field of ['uid', 'name', 'namespace', 'project', 'repoURL'] as const) {
      expect(() =>
        historical({ ...input, application: { ...input.application, [field]: 'foreign' } }),
      ).toThrow('argo_scope_drift');
    }
    for (const field of ['server', 'name', 'namespace'] as const) {
      expect(() =>
        historical({
          ...input,
          application: {
            ...input.application,
            destination: { ...input.application.destination, [field]: 'foreign' },
          },
        }),
      ).toThrow('argo_scope_drift');
    }
    expect(
      historical({ ...input, application: { ...input.application, hasSources: true } }),
    ).toMatchObject({ kind: 'gap', reason: 'multi_source' });
  });
});

describe('archive storage safety', () => {
  it.each(['\u0000', '\ud800', '\udfff'])(
    'rejects PostgreSQL-incompatible strings before journal persistence',
    (unsafe) => {
      expect(() => adapters.archiveRecordDigest({ notification: { value: unsafe } })).toThrow(
        adapters.AdapterError,
      );
      expect(() => adapters.archiveRecordDigest({ notification: { [unsafe]: 'safe' } })).toThrow(
        adapters.AdapterError,
      );
      expect(() => adapters.archiveRecordDigest({ evidence_ref: unsafe })).toThrow(
        adapters.AdapterError,
      );
    },
  );
  it('rejects overlapping or unsorted sealed interruptions', () => {
    const interruptions = [
      { start: '2026-10-10T10:00:00Z', end: '2026-10-10T10:00:30Z', reason: 'first' },
      { start: '2026-10-10T10:00:20Z', end: '2026-10-10T10:00:40Z', reason: 'second' },
    ];
    expect(() => parse(signed({ ...seal(), interruptions }))).toThrow(adapters.AdapterError);
    expect(() => parse(signed({ ...seal(), interruptions: interruptions.toReversed() }))).toThrow(
      adapters.AdapterError,
    );
  });
});
