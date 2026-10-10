import type { ArgoEnrichment } from '@clio/adapters';

/**
 * Reserve serialized snapshot expansion independently of the private grant's size.
 * An artifact exposure may attach a later build with a 2048-code-point repository ID.
 * JSON can escape one code point using six bytes; include quotes in that upper bound.
 * Existing immutable digest locks allow a tighter bound when provenance already exists.
 */
export function enrichmentCaptureReserve(
  event: ArgoEnrichment,
  repositoryJsonBytes = 2048 * 6 + 2,
): number {
  const referenceBytes =
    Buffer.byteLength(JSON.stringify(event.evidence_ref)) +
    Buffer.byteLength(JSON.stringify(event.policy_reference));
  const subjectBytes =
    event.kind === 'consumer_exposure' ? Buffer.byteLength(JSON.stringify(event.subject)) : 0;
  const artifactBytes =
    event.kind === 'consumer_exposure' && event.subject.kind === 'artifact'
      ? repositoryJsonBytes + 1024
      : 0;
  // Receiver metadata, assertion IDs/keys, stable references and per-rollout artifact links.
  return 1536 + referenceBytes * 2 + subjectBytes + artifactBytes;
}
