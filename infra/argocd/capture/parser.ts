import type { ArgoScope } from '../../../packages/adapters/src/argo-notification.ts';
import { applicationNotification } from '../journal/application.ts';
import { fail, object, text } from './config.ts';

export const documentLimit = 512 * 1024;
export function json(bytes: Uint8Array): unknown {
  if (bytes.byteLength > documentLimit) fail('capture_document_size');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('capture_json');
  }
}
export async function* frames(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<unknown> {
  const buffer = Buffer.alloc(documentLimit);
  let length = 0;
  for await (const chunk of chunks) {
    // Copy each bounded segment once. Tiny chunks cannot cause quadratic concatenation.
    let offset = 0;
    for (let index = 0; index < chunk.byteLength; index++) {
      if (chunk[index] !== 10) continue;
      const part = chunk.subarray(offset, index);
      if (length + part.length > documentLimit) fail('capture_document_size');
      buffer.set(part, length);
      length += part.length;
      if (length) yield json(buffer.subarray(0, length));
      length = 0;
      offset = index + 1;
    }
    const tail = chunk.subarray(offset);
    if (length + tail.length > documentLimit) fail('capture_document_size');
    buffer.set(tail, length);
    length += tail.length;
  }
  if (length) yield json(buffer.subarray(0, length));
}
export function cursor(value: unknown): string {
  return text(value, 1024);
}
export function validateApplication(
  value: unknown,
  scope: ArgoScope,
): { input: unknown; cursor: string } {
  const app = object(value);
  const metadata = object(app.metadata);
  if (Object.hasOwn(metadata, 'deletionTimestamp') && metadata.deletionTimestamp !== null)
    fail('capture_deleted');
  const notification = object(applicationNotification(value));
  const native = object(notification.application);
  const destination = object(native.destination);
  if (
    native.uid !== scope.applicationUid ||
    native.name !== scope.applicationName ||
    native.namespace !== scope.applicationNamespace ||
    native.project !== scope.project ||
    destination.server !== scope.destinationServer ||
    destination.name !== scope.destinationName ||
    destination.namespace !== scope.destinationNamespace ||
    (native.repoURL !== scope.repoURL &&
      !(
        native.repoURL === null &&
        (native.hasSources === true || native.hasSourceHydrator === true)
      ))
  )
    fail('capture_scope_drift');
  return { input: value, cursor: cursor(metadata.resourceVersion) };
}
export function parseList(value: unknown, scope: ArgoScope): { input: unknown; cursor: string } {
  const row = object(value);
  if (
    row.apiVersion !== 'argoproj.io/v1alpha1' ||
    row.kind !== 'ApplicationList' ||
    !Array.isArray(row.items) ||
    row.items.length !== 1
  )
    fail('capture_list_scope');
  const item = validateApplication(row.items[0], scope);
  return { input: item.input, cursor: cursor(object(row.metadata).resourceVersion) };
}
export type WatchEvent =
  | { type: 'OBSERVATION'; input: unknown }
  | { type: 'BOOKMARK'; cursor: string }
  | { type: 'EXPIRED' };
export function parseWatchEvent(value: unknown): WatchEvent {
  const row = object(value);
  if (Object.keys(row).sort().join(',') !== 'object,type') fail('capture_watch_event');
  if (row.type === 'DELETED') fail('capture_deleted');
  if (row.type === 'ADDED' || row.type === 'MODIFIED')
    return { type: 'OBSERVATION', input: row.object };
  if (row.type === 'BOOKMARK')
    return {
      type: 'BOOKMARK',
      cursor: cursor(object(object(row.object).metadata).resourceVersion),
    };
  if (row.type === 'ERROR') {
    const status = object(row.object);
    if (status.code === 410) return { type: 'EXPIRED' };
    if (
      status.kind === 'Status' &&
      status.apiVersion === 'v1' &&
      status.status === 'Failure' &&
      typeof status.code === 'number' &&
      Number.isInteger(status.code) &&
      (status.code === 408 || status.code === 429 || (status.code >= 500 && status.code <= 599))
    )
      fail('capture_transport');
  }
  return fail('capture_watch_event');
}
