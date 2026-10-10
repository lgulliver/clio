import { isDeepStrictEqual } from 'node:util';
import { object } from '../identity/input.ts';
import { type ArgoArchiveGrant, type ArgoConfig, parseScope, scopeFor } from './config.ts';
import { type ArgoConnection, parseArchiveProducer } from './input.ts';
export function archiveFor(config: ArgoConfig | null, sourceId: string, producerId: string) {
  return (
    config?.archives?.find((g) => g.sourceId === sourceId && g.producerId === producerId) ?? null
  );
}
export function publicArchive(grant: ArgoArchiveGrant) {
  return {
    producerId: grant.producerId,
    journalId: grant.journalId,
    policyReference: grant.policyReference,
  };
}
export function pinArchive(grant: ArgoArchiveGrant) {
  return { scope: scopeFor(grant), producer: publicArchive(grant), fingerprint: grant.fingerprint };
}
export function parseArchivePin(value: unknown) {
  if (value === null) return null;
  const row = object(value, ['scope', 'producer', 'fingerprint']);
  if (typeof row.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(row.fingerprint))
    throw new Error('Invalid archive pin');
  return {
    scope: parseScope(row.scope),
    producer: parseArchiveProducer(row.producer),
    fingerprint: row.fingerprint,
  };
}
/** undefined means revoked/mismatched; null means no selected archive. */
export function eligibleArchive(
  config: ArgoConfig | null,
  connection: ArgoConnection,
  pin: ReturnType<typeof parseArchivePin>,
): ArgoArchiveGrant | null | undefined {
  if (!connection.archiveProducer) return pin === null ? null : undefined;
  const grant = archiveFor(config, connection.sourceId, connection.archiveProducer.producerId);
  if (
    !grant ||
    !pin ||
    !isDeepStrictEqual(publicArchive(grant), connection.archiveProducer) ||
    !isDeepStrictEqual(pin, pinArchive(grant))
  )
    return undefined;
  return grant;
}
