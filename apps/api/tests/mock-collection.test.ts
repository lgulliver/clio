import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { captureMapping, previewMapping } from '../src/features/deployment-mappings/preview.ts';
import { snapshotDigest } from '../src/features/mock-collection/digest.ts';
import { enqueueInput, parseMapping, run } from '../src/features/mock-collection/model.ts';

const mapping = {
  workspaceId: randomUUID(),
  serviceId: randomUUID(),
  mode: 'mock',
  revision: 1,
  primaryProvider: 'github',
  productionEnvironment: 'production',
  exposureAttested: true,
  observedAt: '2026-10-10T00:00:00.123456Z',
};
const service = { id: mapping.serviceId, name: 'Fictional service' };
function row() {
  return {
    id: randomUUID(),
    workspace_id: mapping.workspaceId,
    service_id: mapping.serviceId,
    mapping_revision: '1',
    mapping_input: mapping,
    service_name: service.name,
    status: 'pending',
    attempts: 0,
    result: null,
    failure_code: null,
    created_at_text: mapping.observedAt,
    updated_at_text: mapping.observedAt,
    completed_at_text: null,
  };
}
describe('mock run boundaries', () => {
  it('hashes persisted JSON independently of object key order while preserving evidence values', () => {
    const first = {
      mapping: { revision: 1, service: 'fixture' },
      evidence: [{ at: 'cutoff', id: 'one' }],
    };
    const reordered = {
      evidence: [{ id: 'one', at: 'cutoff' }],
      mapping: { service: 'fixture', revision: 1 },
    };
    expect(snapshotDigest(first)).toBe(snapshotDigest(reordered));
    expect(snapshotDigest(first)).not.toBe(
      snapshotDigest({ ...first, evidence: [{ at: 'later', id: 'one' }] }),
    );
  });
  it('rejects unknown fields, missing UUIDs and unsafe revisions', () => {
    expect(enqueueInput({ revision: 1, requestId: randomUUID() })).toMatchObject({ revision: 1 });
    for (const body of [
      { revision: 1 },
      { revision: 1, requestId: 'bad' },
      { revision: 0, requestId: randomUUID() },
      { revision: Number.MAX_SAFE_INTEGER + 1, requestId: randomUUID() },
      { revision: 1, requestId: randomUUID(), secret: 'private' },
    ])
      expect(() => enqueueInput(body)).toThrow();
  });
  it('captures both sources with validated metrics and incomplete coverage', () => {
    for (const primaryProvider of ['github', 'argocd']) {
      const parsed = parseMapping({ ...mapping, primaryProvider });
      const capture = captureMapping(parsed, service);
      expect(capture.preview).toEqual(previewMapping(parsed, service));
      expect(capture.snapshot.collection_complete).toBe(false);
      expect(capture.preview.coverage).toEqual({
        collectionComplete: false,
        deploymentHistoryComplete: false,
        recoveryEvidenceComplete: false,
      });
      expect(capture.metrics).toHaveLength(1);
      expect(capture.evidence.deployments[0]?.sourceRef).toContain(`mock:${primaryProvider}`);
    }
  });
  it('fails closed on corrupt stored public result, scope, terminal state and timestamps', () => {
    expect(run(row()).mappingObservedAt).toBe(mapping.observedAt);
    for (const change of [
      { status: 'live' },
      { attempts: 4 },
      { workspace_id: randomUUID() },
      { result: {} },
      { completed_at_text: mapping.observedAt },
      { created_at_text: 'bad' },
      { failure_code: 'private' },
    ])
      expect(() => run({ ...row(), ...change })).toThrow();
    const result = previewMapping(parseMapping(mapping), service);
    const terminal = {
      ...row(),
      status: 'succeeded',
      attempts: 1,
      result,
      completed_at_text: mapping.observedAt,
    };
    expect(run(terminal).result).toEqual(result);
    expect(() => run({ ...terminal, completed_at_text: '2026-10-10T00:00:00.123457Z' })).toThrow();
    expect(() => run({ ...terminal, updated_at_text: '2026-10-10T00:00:00.123455Z' })).toThrow();
    expect(() => run({ ...terminal, result: { ...result, rawEvidence: 'private' } })).toThrow();
    expect(() => run({ ...terminal, result: { ...result, mappingRevision: 2 } })).toThrow();
  });
});
