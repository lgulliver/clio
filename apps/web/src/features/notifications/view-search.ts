export type NotificationSearch = {
  workspace?: string;
  pulse?: string;
  notificationLink?: 'success' | 'failed';
};

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function id(value: unknown): string | undefined {
  return typeof value === 'string' && uuid.test(value) ? value.toLowerCase() : undefined;
}

/**
 * Allowlist for notification links. A pulse is accepted only together with a valid workspace;
 * a malformed pair is rejected whole. The fixed Slack outcome is accepted only on a
 * workspace-only link, and a workspace-free `failed` outcome (the server callback failure) is
 * accepted alone; a workspace-free success is not. No return URL, provider code or other key is ever carried through.
 */
export function parseNotificationSearch(value: unknown): NotificationSearch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const workspace = id(Reflect.get(value, 'workspace'));
  const rawPulse = Reflect.get(value, 'pulse');
  const outcome = Reflect.get(value, 'notificationLink');
  const rawWorkspace = Reflect.get(value, 'workspace');
  // The server's untrusted-state failure callback carries no workspace; it selects nothing.
  if (rawWorkspace === undefined && rawPulse === undefined)
    return outcome === 'failed' ? { notificationLink: 'failed' } : {};
  if (!workspace) return {};
  if (rawPulse !== undefined) {
    const pulse = id(rawPulse);
    return pulse ? { workspace, pulse } : {};
  }
  return outcome === 'success' || outcome === 'failed'
    ? { workspace, notificationLink: outcome }
    : { workspace };
}
