import { uuid } from '../identity/input.ts';
import type { NoticeMessage, NotificationKind } from './contract.ts';

const route = '/developer-experience';

function fixedOrigin(origin: string): string {
  const url = new URL(origin);
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    origin !== url.origin
  )
    throw new Error('Invalid notification origin');
  return url.origin;
}
/** Workspace-only link used by test notices; it names no pulse. */
export function buildWorkspaceLink(origin: string, workspaceId: string): string {
  return `${fixedOrigin(origin)}${route}?workspace=${uuid(workspaceId)}`;
}
/** The only pulse link shape notifications may carry. */
export function buildPulseLink(origin: string, workspaceId: string, pulseId: string): string {
  return `${buildWorkspaceLink(origin, workspaceId)}&pulse=${uuid(pulseId)}`;
}
function validatedLink(link: string): string {
  const url = new URL(link);
  const keys = [...url.searchParams.keys()];
  const workspace = url.searchParams.get('workspace');
  const pulse = url.searchParams.get('pulse');
  const expected =
    workspace === null
      ? null
      : pulse === null
        ? buildWorkspaceLink(url.origin, workspace)
        : buildPulseLink(url.origin, workspace, pulse);
  if (
    expected === null ||
    expected !== link ||
    url.pathname !== route ||
    keys.length !== (pulse === null ? 1 : 2)
  )
    throw new Error('Invalid notification link');
  return link;
}
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const wording: Readonly<
  Record<
    NotificationKind,
    Readonly<{ subject: string; lead: string; slack: string; action: string }>
  >
> = {
  invitation: {
    subject: 'A team pulse is open',
    lead: 'A team pulse is open and your input is welcome.',
    slack: 'A team pulse is open.',
    action: 'Open the pulse in Clio',
  },
  reminder: {
    subject: 'Reminder: a team pulse is open',
    lead: 'A team pulse is still open if you would like to take part.',
    slack: 'Reminder: a team pulse is open.',
    action: 'Open the pulse in Clio',
  },
  closure: {
    subject: 'Pulse closed',
    lead: 'A team pulse has closed. You can find it in Clio.',
    slack: 'Pulse closed.',
    action: 'Open the pulse in Clio',
  },
  test: {
    subject: 'Clio notification test',
    lead: 'This is a test notification from Clio. No action is needed.',
    slack: 'Clio notification test.',
    action: 'Open Clio',
  },
};

export function renderNotice(kind: NotificationKind, link: string): NoticeMessage {
  const target = validatedLink(link);
  const words = wording[kind];
  return {
    subject: words.subject,
    text: `${words.lead}\n\n${words.action}: ${target}\n`,
    html: `<p>${escapeHtml(words.lead)}</p><p><a href="${escapeHtml(target)}">${escapeHtml(words.action)}</a></p>`,
    slackText: `${words.slack} <${target}|${words.action}>`,
  };
}
