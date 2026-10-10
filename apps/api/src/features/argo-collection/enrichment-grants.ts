import { isDeepStrictEqual } from 'node:util';
import { object } from '../identity/input.ts';
import {
  type ArgoConfig,
  type ArgoProducerGrant,
  parseProducerScope,
  producerFor,
  producerScopeFor,
} from './config.ts';
import { type ArgoConnection, parseProducers } from './input.ts';

export function publicProducer(
  grant: Pick<ArgoProducerGrant, 'producerId' | 'capability' | 'policyReference'>,
) {
  return {
    producerId: grant.producerId,
    capability: grant.capability,
    policyReference: grant.policyReference,
  };
}
export function pinProducer(grant: ArgoProducerGrant) {
  return { scope: producerScopeFor(grant), fingerprint: grant.fingerprint };
}
export function parsePins(value: unknown) {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Invalid stored producer pins');
  const pins = value
    .map((value: unknown) => {
      const row = object(value, ['scope', 'fingerprint']);
      if (typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint))
        throw new Error('Invalid stored producer pin');
      return { scope: parseProducerScope(row.scope), fingerprint: row.fingerprint };
    })
    .sort((a, b) => a.scope.producerId.localeCompare(b.scope.producerId));
  parseProducers(pins.map((p) => publicProducer(p.scope)));
  return pins;
}
export function eligibleProducers(
  config: ArgoConfig | null,
  connection: ArgoConnection,
  pins: ReturnType<typeof parsePins>,
): ArgoProducerGrant[] | null {
  const selected = connection.enrichmentProducers ?? [];
  if (selected.length !== pins.length) return null;
  const grants: ArgoProducerGrant[] = [];
  for (const producer of selected) {
    const grant = producerFor(config, connection.sourceId, producer.producerId);
    const pin = pins.find((p) => p.scope.producerId === producer.producerId);
    if (
      !grant ||
      !pin ||
      grant.workspaceId !== connection.workspaceId ||
      grant.serviceId !== connection.serviceId ||
      !isDeepStrictEqual(publicProducer(grant), producer) ||
      pin.fingerprint !== grant.fingerprint ||
      !isDeepStrictEqual(pin.scope, producerScopeFor(grant))
    )
      return null;
    grants.push(grant);
  }
  return grants;
}
