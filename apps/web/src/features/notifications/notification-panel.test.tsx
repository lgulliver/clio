import { QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../lib/query-client';
import {
  closedQuestions,
  historyId,
  instrumentBody,
  json,
  openPulse,
  type PulseFixture,
  pulse,
  pulseId,
  teamA,
  workspaceId,
} from '../space/fixtures.test-support';
import { DeveloperExperiencePage } from '../space/space-page';
import { slackNavigation } from './own-link';

const session = vi.hoisted(() => ({
  status: 'ready' as 'ready' | 'signed-out',
  revision: 1,
  valid: true,
  emailVerified: true,
  expire: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('../identity/session', () => ({
  useSession: () => ({
    status: session.status,
    user:
      session.status === 'ready'
        ? {
            id: 'alice',
            name: 'Alice',
            email: 'alice@example.test',
            emailVerified: session.emailVerified,
          }
        : null,
    revision: session.revision,
    current: (revision: number) => session.valid && revision === session.revision,
    expire: session.expire,
    refresh: session.refresh,
  }),
}));

const secondWorkspace = '77777777-7777-4777-8777-777777777777';
const colleagueEmail = 'colleague@example.test';
const colleagueSlack = 'U0COLLEAGUE';
const at = '2026-10-13T09:00:00.000Z';
type Call = { method: string; path: string; body: unknown };
type Policy = {
  revision: number;
  enabled: boolean;
  invitations: boolean;
  closures: boolean;
  reminders: boolean;
  firstReminderHours: number;
  repeatHours: number;
  maximumReminders: number;
};
const disabledPolicy: Policy = {
  revision: 0,
  enabled: false,
  invitations: true,
  closures: true,
  reminders: true,
  firstReminderHours: 48,
  repeatHours: 72,
  maximumReminders: 2,
};
const zeroCounts = {
  pending: 0,
  leased: 0,
  retry_scheduled: 0,
  provider_accepted: 0,
  skipped: 0,
  failed: 0,
  uncertain: 0,
};

const net = {
  role: 'owner' as 'owner' | 'member',
  listed: true,
  availability: { emailConfigured: true, slackConfigured: true, linkingConfigured: true },
  policy: disabledPolicy,
  link: { linked: false, revision: 0, linkedAt: null as string | null },
  history: new Map<string, unknown>(),
  historyStatus: 200,
  summary: { counts: { ...zeroCounts }, remindersEnabled: true, revision: 5 },
  pulses: [] as PulseFixture[],
  hold: new Map<string, Promise<Response>>(),
  override: undefined as ((call: Call) => Response | Promise<Response> | undefined) | undefined,
  calls: [] as Call[],
};

function respond(input: string | URL | Request, init?: RequestInit): Response | Promise<Response> {
  const url = new URL(String(input));
  const call: Call = {
    method: init?.method ?? 'GET',
    path: `${url.pathname}${url.search}`,
    body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
  };
  net.calls.push(call);
  const overridden = net.override?.(call);
  if (overridden) return overridden;
  const held = net.hold.get(`${call.method} ${url.pathname}`);
  if (held) return held;
  if (url.pathname === '/api/workspaces')
    return json({
      workspaces: [
        ...(net.listed ? [{ id: workspaceId, name: 'Engineering', role: net.role }] : []),
        { id: secondWorkspace, name: 'Research', role: 'member' },
      ],
    });
  const match = /^\/api\/workspaces\/([0-9a-f-]+)\/(.*)$/.exec(url.pathname);
  const scope = match?.[1];
  const rest = match?.[2];
  if (!scope || rest === undefined) return json({ error: 'not_found' }, 404);
  if (!net.listed && scope === workspaceId) return json({ error: 'not_found' }, 404);
  if (rest === 'organization')
    return json({
      workspaceId: scope,
      teams: [{ id: teamA, workspaceId: scope, name: 'Platform' }],
      products: [],
      services: [],
      assignments: [],
    });
  if (rest === 'space/instrument') return json(instrumentBody());
  if (rest === 'space/preferences') return json({ workspaceId: scope, minimumRespondents: 3 });
  if (rest === 'space/github/availability')
    return json(
      net.role === 'owner'
        ? { workspaceId: scope, enabled: false, grants: [] }
        : { workspaceId: scope, enabled: false },
    );
  if (rest === 'space/github/mappings')
    return json({
      workspaceId: scope,
      teamId: url.searchParams.get('teamId'),
      mappings: [],
      nextCursor: null,
    });
  if (rest === 'space/assignment')
    return json({
      workspaceId: scope,
      teamId: null,
      teamName: null,
      history: [],
      nextCursor: null,
    });
  if (rest === 'space/pulses')
    return json({ workspaceId: scope, pulses: net.pulses, nextCursor: null });
  const detail = /^space\/pulses\/([0-9a-f-]+)$/.exec(rest);
  if (detail) {
    const found = net.pulses.find((item) => item.id === detail[1]);
    return found ? json({ pulse: found }) : json({ error: 'not_found' }, 404);
  }
  if (rest === 'notifications/availability')
    return json({ workspaceId: scope, ...net.availability });
  if (rest === 'notifications/policy') {
    if (net.role !== 'owner') return json({ error: 'forbidden' }, 403);
    if (call.method === 'PATCH')
      return json({
        policy: { ...(call.body as Policy), revision: (call.body as Policy).revision + 1 },
      });
    return json({ policy: net.policy });
  }
  if (rest === 'notifications/slack-link') return json({ link: net.link });
  if (rest === 'notifications/slack-link/start')
    return json({
      authorizeUrl: 'https://slack.com/openid/connect/authorize?response_type=code&state=opaque',
    });
  if (rest === 'notifications/slack-link/unlink')
    return json({ link: { linked: false, revision: net.link.revision + 1, linkedAt: null } });
  if (rest === 'notifications/history') {
    if (net.historyStatus !== 200) return json({ error: 'unavailable' }, net.historyStatus);
    const cursor = url.searchParams.get('cursor') ?? '';
    const page = net.history.get(cursor);
    return page ? json(page) : json({ error: 'not_found' }, 404);
  }
  const summary = /^notifications\/pulses\/([0-9a-f-]+)$/.exec(rest);
  if (summary) {
    if (net.role !== 'owner') return json({ error: 'forbidden' }, 403);
    return json({ workspaceId: scope, pulseId: summary[1], ...net.summary });
  }
  const action = /^notifications\/pulses\/([0-9a-f-]+)\/(remind|retry)$/.exec(rest);
  if (action && call.method === 'POST')
    return json({ requestId: (call.body as { requestId: string }).requestId, queued: true }, 202);
  const off = /^notifications\/pulses\/([0-9a-f-]+)\/reminders\/disable$/.exec(rest);
  if (off && call.method === 'POST') {
    net.summary = { ...net.summary, remindersEnabled: false, revision: net.summary.revision + 1 };
    return json({
      workspaceId: scope,
      pulseId: off[1],
      ...net.summary,
    });
  }
  if (rest === 'notifications/test' && call.method === 'POST')
    return json({ requestId: (call.body as { requestId: string }).requestId, queued: true }, 202);
  return json({ error: 'not_found' }, 404);
}
const fetchMock = vi.fn(respond);

function mutations() {
  return net.calls.filter((call) => call.method !== 'GET');
}
function requestIdOf(index: number) {
  const body = mutations()[index]?.body;
  return typeof body === 'object' && body !== null ? Reflect.get(body, 'requestId') : undefined;
}
function row(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: historyId(index),
    pulseId: pulseId(2),
    kind: 'invitation',
    state: 'provider_accepted',
    channel: 'slack',
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
function deferred() {
  let resolve: (value: Response) => void = () => {};
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function mountPage(target?: { workspaceId: string; pulseId?: string }) {
  const client = createQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <DeveloperExperiencePage {...(target ? { initialTarget: target } : {})} />
    </QueryClientProvider>,
  );
  await screen.findByRole('heading', { name: 'Pulse notifications' });
  return view;
}
const panel = () => screen.getByRole('region', { name: 'Pulse notifications' });

beforeEach(() => {
  session.status = 'ready';
  session.revision = 1;
  session.valid = true;
  session.emailVerified = true;
  session.expire.mockClear();
  net.role = 'owner';
  net.listed = true;
  net.availability = { emailConfigured: true, slackConfigured: true, linkingConfigured: true };
  net.policy = disabledPolicy;
  net.link = { linked: false, revision: 0, linkedAt: null };
  net.history = new Map([['', { workspaceId, items: [], nextCursor: null }]]);
  net.historyStatus = 200;
  net.summary = { counts: { ...zeroCounts }, remindersEnabled: true, revision: 5 };
  net.pulses = [];
  net.hold = new Map();
  net.override = undefined;
  net.calls = [];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('owner setup wizard', () => {
  it('starts disabled and explains missing configuration without offering to enable', async () => {
    net.availability = { emailConfigured: false, slackConfigured: false, linkingConfigured: false };
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    expect(await screen.findByText(/Notifications are disabled/)).toBeVisible();
    expect(screen.getByText(/No delivery integration is configured/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Set up notifications' }));
    const heading = screen.getByRole('heading', { name: /Step 1 of 4: Integration/ });
    expect(heading).toHaveFocus();
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toHaveAttribute('aria-disabled', 'true');
    await user.click(next);
    expect(screen.getByRole('heading', { name: /Step 1 of 4/ })).toBeVisible();
    // No credential, address or destination entry exists anywhere in setup.
    expect(within(panel()).queryByRole('textbox')).not.toBeInTheDocument();
    expect(mutations()).toHaveLength(0);
  });

  it('walks four stages, validates timings, and sends only after explicit confirmations', async () => {
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await user.click(await screen.findByRole('button', { name: 'Set up notifications' }));
    expect(screen.getByText(/Slack delivery: available/)).toBeVisible();
    expect(screen.getByText(/falls back to verified email/)).toBeVisible();
    expect(screen.getByText(/does not send a second message by itself/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: /Step 2 of 4: Messages and timing/ })).toHaveFocus();

    // Invalid timing blocks the stage with an alert; nothing is saved.
    const first = screen.getByLabelText(/First reminder after/);
    await user.clear(first);
    await user.type(first, '12');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('alert')).toHaveTextContent(/whole hours from 24 to 168/);
    await user.clear(first);
    await user.type(first, '24');
    // Reminders off keeps the timing fields; they stay independent of the switch.
    await user.click(screen.getByRole('checkbox', { name: /Reminders while a pulse is open/ }));
    expect(first).toHaveValue('24');
    await user.click(screen.getByRole('checkbox', { name: /Reminders while a pulse is open/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getByRole('heading', { name: /Step 3 of 4: Preview and test/ })).toHaveFocus();
    expect(screen.getByText('A team pulse is open')).toBeVisible();
    expect(screen.getByText(/contains no answers/)).toBeVisible();
    // Slack is configured but not linked for this member, so only email can be tested.
    expect(screen.getByRole('radio', { name: /My Slack account/ })).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /My verified sign-in email/ }));
    await user.click(screen.getByRole('button', { name: 'Send a test to me' }));
    expect(mutations()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Confirm send test' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Confirm send test' }));
    expect(await screen.findByText(/test message to your own email is queued/)).toBeVisible();
    expect(screen.getByText(/does not prove you will see it/)).toBeVisible();
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0]).toMatchObject({
      method: 'POST',
      path: `/api/workspaces/${workspaceId}/notifications/test`,
      body: { revision: 0, confirm: true, channel: 'email' },
    });
    expect(Object.keys((mutations()[0]?.body as object) ?? {}).sort()).toEqual(
      ['channel', 'confirm', 'requestId', 'revision'].sort(),
    );

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: /Step 4 of 4: Enable/ })).toHaveFocus();
    expect(screen.getByText(/applies only to pulses opened afterwards/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
    expect(mutations()).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Confirm enable notifications' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Confirm enable notifications' }));
    expect(await screen.findByRole('heading', { name: 'Notifications are enabled' })).toHaveFocus();
    expect(mutations()[1]).toEqual({
      method: 'PATCH',
      path: `/api/workspaces/${workspaceId}/notifications/policy`,
      body: {
        revision: 0,
        enabled: true,
        invitations: true,
        closures: true,
        reminders: true,
        firstReminderHours: 24,
        repeatHours: 72,
        maximumReminders: 2,
      },
    });
  });

  it('does not enable from a rate limit and shows fixed text instead of provider detail', async () => {
    net.override = (call) =>
      call.method === 'PATCH'
        ? json({ error: 'rate_limited', detail: 'xoxb-secret provider said slow down 59s' }, 429)
        : undefined;
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await user.click(await screen.findByRole('button', { name: 'Set up notifications' }));
    for (let index = 0; index < 3; index += 1)
      await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
    await user.click(screen.getByRole('button', { name: 'Confirm enable notifications' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Notifications are temporarily rate limited. Wait a while before trying again.',
    );
    expect(panel()).not.toHaveTextContent('xoxb-secret');
    expect(panel()).not.toHaveTextContent('59');
    expect(screen.queryByRole('heading', { name: 'Notifications are enabled' })).toBeNull();
  });

  it('reuses the same test request after an unknown outcome so a repeat cannot send twice', async () => {
    let attempts = 0;
    net.override = (call) => {
      if (!call.path.endsWith('/notifications/test')) return undefined;
      attempts += 1;
      return attempts === 1 ? json({ error: 'unavailable' }, 503) : undefined;
    };
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await user.click(await screen.findByRole('button', { name: 'Set up notifications' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('radio', { name: /My verified sign-in email/ }));
    await user.click(screen.getByRole('button', { name: 'Send a test to me' }));
    await user.click(screen.getByRole('button', { name: 'Confirm send test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not confirm whether the test/,
    );
    await user.click(screen.getByRole('button', { name: 'Check the test request again' }));
    expect(await screen.findByText(/is queued/)).toBeVisible();
    const sends = mutations();
    expect(sends).toHaveLength(2);
    expect(sends[0]?.body).toEqual(sends[1]?.body);
  });

  it('keeps an enabled workspace revision-checked and disables only after confirmation', async () => {
    net.policy = { ...disabledPolicy, enabled: true, revision: 3, reminders: false };
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    expect(
      await screen.findByText(/Notifications are enabled for pulses opened after/),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Disable notifications' }));
    expect(mutations()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Confirm disable notifications' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Confirm disable notifications' }));
    expect(await screen.findByText(/Pending messages are cancelled\./)).toBeVisible();
    expect(mutations()).toEqual([
      {
        method: 'PATCH',
        path: `/api/workspaces/${workspaceId}/notifications/policy`,
        body: { ...net.policy, enabled: false },
      },
    ]);
  });

  it('ignores a late enable result after the workspace changes', async () => {
    const hold = deferred();
    net.hold.set('PATCH', hold.promise);
    net.hold = new Map([
      [`PATCH /api/workspaces/${workspaceId}/notifications/policy`, hold.promise],
    ]);
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await user.click(await screen.findByRole('button', { name: 'Set up notifications' }));
    for (let index = 0; index < 3; index += 1)
      await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
    await user.click(screen.getByRole('button', { name: 'Confirm enable notifications' }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    await user.selectOptions(screen.getByLabelText('Workspace'), secondWorkspace);
    await act(async () => {
      hold.resolve(json({ policy: { ...disabledPolicy, enabled: true, revision: 1 } }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('heading', { name: 'Notifications are enabled' })).toBeNull();
    expect(screen.queryByText(/Notifications are enabled for/)).toBeNull();
  });

  it('ignores a late enable result once the session is no longer current', async () => {
    const hold = deferred();
    net.hold = new Map([
      [`PATCH /api/workspaces/${workspaceId}/notifications/policy`, hold.promise],
    ]);
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await user.click(await screen.findByRole('button', { name: 'Set up notifications' }));
    for (let index = 0; index < 3; index += 1)
      await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
    await user.click(screen.getByRole('button', { name: 'Confirm enable notifications' }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    session.valid = false;
    await act(async () => {
      hold.resolve(json({ policy: { ...disabledPolicy, enabled: true, revision: 1 } }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('heading', { name: 'Notifications are enabled' })).toBeNull();
  });
});

describe('member linking and own history', () => {
  beforeEach(() => {
    net.role = 'member';
  });

  it('shows only member controls, never reads owner policy or a summary, and sends nothing on refresh', async () => {
    net.history = new Map([
      [
        '',
        {
          workspaceId,
          items: [
            row(1),
            row(2, { kind: 'test', pulseId: null, state: 'uncertain', channel: 'email' }),
          ],
          nextCursor: null,
        },
      ],
    ]);
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    expect(await screen.findByText('Test message')).toBeVisible();
    expect(screen.getByText('Accepted by the provider')).toBeVisible();
    expect(screen.getByText('Outcome unknown')).toBeVisible();
    expect(screen.queryByText('Owner settings')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Set up notifications' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Refresh notification status' }));
    await waitFor(() =>
      expect(net.calls.filter((c) => c.path.endsWith('/notifications/history')).length).toBe(2),
    );
    expect(net.calls.some((c) => c.path.endsWith('/notifications/policy'))).toBe(false);
    expect(net.calls.some((c) => /notifications\/pulses\//.test(c.path))).toBe(false);
    expect(mutations()).toHaveLength(0);
    expect(document.body).not.toHaveTextContent(colleagueEmail);
    expect(document.body).not.toHaveTextContent(colleagueSlack);
  });

  it('starts linking at the server-provided Slack URL only after the member asks', async () => {
    const go = vi.spyOn(slackNavigation, 'go').mockImplementation(() => {});
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await screen.findByText(/No Slack account linked/);
    expect(go).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Link Slack account' }));
    await waitFor(() => expect(go).toHaveBeenCalledTimes(1));
    expect(go).toHaveBeenCalledWith(
      'https://slack.com/openid/connect/authorize?response_type=code&state=opaque',
    );
    expect(mutations()).toEqual([
      {
        method: 'POST',
        path: `/api/workspaces/${workspaceId}/notifications/slack-link/start`,
        body: {},
      },
    ]);
    go.mockRestore();
  });

  it('never navigates to a start URL that is not the Slack OpenID endpoint', async () => {
    const go = vi.spyOn(slackNavigation, 'go').mockImplementation(() => {});
    net.override = (call) =>
      call.path.endsWith('/slack-link/start')
        ? json({ authorizeUrl: 'https://evil.example/openid/connect/authorize' })
        : undefined;
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await user.click(await screen.findByRole('button', { name: 'Link Slack account' }));
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(go).not.toHaveBeenCalled();
    go.mockRestore();
  });

  it('does not treat a successful Slack callback as proof of a link', async () => {
    const client = createQueryClient();
    render(
      <QueryClientProvider client={client}>
        <DeveloperExperiencePage
          initialTarget={{ workspaceId }}
          notificationLink="success"
          navigationKey="entry-1"
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/This result has not been checked here/)).toBeVisible();
    expect(await screen.findByText(/No Slack account linked/)).toBeVisible();
    expect(screen.queryByText(/Slack account linked on/)).toBeNull();
  });

  it('unlinks with the current revision only after confirmation and shows the read-back state', async () => {
    net.link = { linked: true, revision: 4, linkedAt: at };
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    expect(await screen.findByText(/Slack account linked on 2026-10-13/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Unlink Slack account' }));
    expect(mutations()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Confirm unlink Slack' })).toHaveFocus();
    net.link = { linked: false, revision: 5, linkedAt: null };
    await user.click(screen.getByRole('button', { name: 'Confirm unlink Slack' }));
    expect(await screen.findByText(/Slack unlinked/)).toBeVisible();
    expect(mutations()).toEqual([
      {
        method: 'POST',
        path: `/api/workspaces/${workspaceId}/notifications/slack-link/unlink`,
        body: { revision: 4 },
      },
    ]);
    await screen.findByText(/No Slack account linked/);
  });

  it('keeps own history and the email fallback explanation when Slack is not configured', async () => {
    net.availability = { emailConfigured: true, slackConfigured: false, linkingConfigured: false };
    net.history = new Map([
      ['', { workspaceId, items: [row(1, { channel: 'email' })], nextCursor: null }],
    ]);
    await mountPage({ workspaceId });
    expect(
      await screen.findByText(/Slack linking is not available for this workspace/),
    ).toBeVisible();
    expect(screen.getByText(/uses your verified sign-in email/)).toBeVisible();
    expect(await screen.findByText('Email')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Link Slack account' })).toBeNull();
  });

  it('says an unverified sign-in email cannot be a fallback', async () => {
    session.emailVerified = false;
    await mountPage({ workspaceId });
    expect(await screen.findByText(/sign-in email is not verified/)).toBeVisible();
  });

  it('pages own history 25 at a time and recovers to the newest page when a cursor is gone', async () => {
    const full = Array.from({ length: 25 }, (_, index) => row(index + 1));
    net.history = new Map<string, unknown>([
      ['', { workspaceId, items: full, nextCursor: 'cursor_two' }],
      ['cursor_two', { workspaceId, items: [row(40, { kind: 'closure' })], nextCursor: null }],
    ]);
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await screen.findAllByText('Pulse opened');
    await user.click(screen.getByRole('button', { name: 'Older notifications' }));
    expect(await screen.findByText('Pulse closed')).toBeVisible();
    expect(net.calls.some((c) => c.path.endsWith('history?cursor=cursor_two'))).toBe(true);
    // The anchor disappears: access is unchanged, so the newest page returns with a notice.
    net.history = new Map([['', { workspaceId, items: full, nextCursor: 'cursor_two' }]]);
    await user.click(screen.getByRole('button', { name: 'Newest notifications' }));
    await screen.findAllByText('Pulse opened');
    await user.click(screen.getByRole('button', { name: 'Older notifications' }));
    expect(await screen.findByText(/no longer available\. Showing the newest/)).toBeVisible();
    expect((await screen.findAllByText('Pulse opened')).length).toBe(25);
  });

  it('does not turn an unavailable history into an empty one', async () => {
    net.historyStatus = 503;
    await mountPage({ workspaceId });
    expect(
      await screen.findByText('Your notification history is unavailable right now.'),
    ).toBeVisible();
    expect(screen.queryByText('No notifications yet.')).toBeNull();
  });

  it('ignores a late link read once the session is no longer current', async () => {
    const hold = deferred();
    net.hold = new Map([
      [`GET /api/workspaces/${workspaceId}/notifications/slack-link`, hold.promise],
    ]);
    await mountPage({ workspaceId });
    session.valid = false;
    await act(async () => {
      hold.resolve(json({ link: { linked: true, revision: 1, linkedAt: at } }));
      await Promise.resolve();
    });
    expect(screen.queryByText(/Slack account linked on/)).toBeNull();
  });
});

describe('owner aggregate delivery controls', () => {
  beforeEach(() => {
    net.pulses = [openPulse({ id: pulseId(2), teamName: 'Platform', submittedCount: 1 })];
  });

  it('shows aggregate totals only, never named recipients, and refresh sends nothing', async () => {
    net.summary = {
      counts: { ...zeroCounts, provider_accepted: 4, failed: 2, skipped: 1 },
      remindersEnabled: true,
      revision: 5,
    };
    const user = userEvent.setup();
    await mountPage({ workspaceId, pulseId: pulseId(2) });
    const section = await screen.findByRole('region', { name: 'Notification delivery' });
    expect(
      (await within(section).findByText('Accepted by the provider')).closest('div'),
    ).toHaveTextContent('4');
    expect(within(section).getByText('Could not send').closest('div')).toHaveTextContent('2');
    expect(section).toHaveTextContent(/no names, destinations or reasons per person/);
    expect(section).not.toHaveTextContent(colleagueEmail);
    expect(section).not.toHaveTextContent(colleagueSlack);
    await user.click(within(section).getByRole('button', { name: 'Refresh delivery status' }));
    await user.click(screen.getByRole('button', { name: 'Refresh notification status' }));
    expect(mutations()).toHaveLength(0);
  });

  it('queues a reminder batch only after confirmation with the current revision', async () => {
    const user = userEvent.setup();
    await mountPage({ workspaceId, pulseId: pulseId(2) });
    await user.click(await screen.findByRole('button', { name: 'Queue reminder batch' }));
    expect(mutations()).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Confirm queue reminders' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Confirm queue reminders' }));
    expect(await screen.findByText(/reminder batch is queued/)).toBeVisible();
    expect(mutations()).toHaveLength(1);
    expect(mutations()[0]).toMatchObject({
      path: `/api/workspaces/${workspaceId}/notifications/pulses/${pulseId(2)}/remind`,
      body: { revision: 5, confirm: true },
    });
    expect(Object.keys((mutations()[0]?.body as object) ?? {}).sort()).toEqual([
      'confirm',
      'requestId',
      'revision',
    ]);
  });

  it('turns reminders off with the revision only, then hides the reminder controls', async () => {
    const user = userEvent.setup();
    await mountPage({ workspaceId, pulseId: pulseId(2) });
    await user.click(
      await screen.findByRole('button', { name: 'Turn off reminders for this pulse' }),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm turn off reminders' }));
    expect(await screen.findByText(/Reminders are turned off for this pulse/)).toBeVisible();
    expect(mutations()[0]?.body).toEqual({ revision: 5 });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Queue reminder batch' })).toBeNull(),
    );
  });

  it('warns that retrying an unknown outcome may duplicate a message and sends the flag only when chosen', async () => {
    net.summary = {
      counts: { ...zeroCounts, failed: 1, uncertain: 2 },
      remindersEnabled: false,
      revision: 7,
    };
    const user = userEvent.setup();
    await mountPage({ workspaceId, pulseId: pulseId(2) });
    await user.click(await screen.findByRole('button', { name: 'Retry failed deliveries' }));
    expect(screen.getByText(/may already have arrived/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Confirm retry' }));
    await screen.findByText(/retry batch is queued/);
    expect(mutations()[0]?.body).not.toHaveProperty('confirmUncertain');
    await user.click(screen.getByRole('button', { name: 'Retry failed deliveries' }));
    await user.click(screen.getByRole('checkbox', { name: /outcome is unknown/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm retry' }));
    await waitFor(() => expect(mutations()).toHaveLength(2));
    expect(mutations()[1]?.body).toMatchObject({
      revision: 7,
      confirm: true,
      confirmUncertain: true,
    });
    expect(requestIdOf(1)).not.toBe(requestIdOf(0));
  });

  it('keeps failed help honest after an owner-confirmed uncertain retry is refused', async () => {
    net.summary = {
      counts: { ...zeroCounts, uncertain: 1 },
      remindersEnabled: true,
      revision: 5,
    };
    net.override = (call) => {
      if (call.method === 'POST' && call.path.endsWith('/retry')) {
        net.summary = { ...net.summary, counts: { ...zeroCounts, failed: 1 } };
      }
      return undefined;
    };
    const user = userEvent.setup();
    await mountPage({ workspaceId, pulseId: pulseId(2) });
    await user.click(await screen.findByRole('button', { name: 'Retry failed deliveries' }));
    await user.click(screen.getByRole('checkbox', { name: /outcome is unknown/ }));
    await user.click(screen.getByRole('button', { name: 'Confirm retry' }));
    await screen.findByText(/retry batch is queued/);
    const section = screen.getByRole('region', { name: 'Notification delivery' });
    await waitFor(() =>
      expect(within(section).getByText('Could not send').closest('div')).toHaveTextContent('1'),
    );
    const failed = within(section).getByText('Could not send').closest('div');
    expect(failed).toHaveTextContent(/Not accepted on the latest attempt/);
    expect(failed).toHaveTextContent(/earlier submission may have arrived/);
    expect(section).not.toHaveTextContent('Definitely not accepted by any destination');
    expect(section).not.toHaveTextContent(colleagueSlack);
    expect(section).not.toHaveTextContent(colleagueEmail);
  });

  it('explains reminder blockers beside bounded retry controls without promising recovery', async () => {
    net.summary = {
      counts: { ...zeroCounts, failed: 1 },
      remindersEnabled: true,
      revision: 5,
    };
    await mountPage({ workspaceId, pulseId: pulseId(2) });
    const retry = await screen.findByRole('button', { name: 'Retry failed deliveries' });
    expect(retry).toHaveAccessibleDescription(/Older failed or unknown invitations and reminders/);
    expect(retry).toHaveAccessibleDescription(/Missed reminder slots are not restored/);
    expect(retry).toHaveAccessibleDescription(/Invitations have no time expiry/);
    expect(retry).toHaveAccessibleDescription(/Exhausted attempt limits cannot be retried/);
    const section = screen.getByRole('region', { name: 'Notification delivery' });
    expect(section).toHaveTextContent(/turn off reminders for this pulse/);
    expect(section).not.toHaveTextContent(colleagueSlack);
    expect(section).not.toHaveTextContent(colleagueEmail);
    expect(mutations()).toHaveLength(0);
  });

  it('offers no retry when nothing failed and no reminders on a closed pulse', async () => {
    net.pulses = [pulse({ id: pulseId(2), teamName: 'Platform', questions: closedQuestions() })];
    await mountPage({ workspaceId, pulseId: pulseId(2) });
    await screen.findByRole('region', { name: 'Notification delivery' });
    expect(screen.queryByRole('button', { name: 'Retry failed deliveries' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Queue reminder batch' })).toBeNull();
  });

  it('replays the identical request after an unknown outcome instead of starting a new send', async () => {
    let attempts = 0;
    net.override = (call) => {
      if (!call.path.endsWith('/remind')) return undefined;
      attempts += 1;
      return attempts === 1 ? json({ error: 'unavailable' }, 503) : undefined;
    };
    const user = userEvent.setup();
    await mountPage({ workspaceId, pulseId: pulseId(2) });
    await user.click(await screen.findByRole('button', { name: 'Queue reminder batch' }));
    await user.click(screen.getByRole('button', { name: 'Confirm queue reminders' }));
    expect(
      await screen.findByText(/could not confirm whether this request was accepted/),
    ).toBeVisible();
    // A new request cannot be started until the unknown one is checked.
    expect(screen.getByRole('button', { name: 'Queue reminder batch' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Queue reminder batch' }));
    expect(screen.queryByRole('button', { name: 'Confirm queue reminders' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Check the request again' }));
    expect(await screen.findByText(/reminder batch is queued/)).toBeVisible();
    const sends = mutations();
    expect(sends).toHaveLength(2);
    expect(sends[1]?.body).toEqual(sends[0]?.body);
  });

  it('shows a conflict plainly and refreshes instead of claiming reminders were queued', async () => {
    net.override = (call) =>
      call.path.endsWith('/remind') ? json({ error: 'conflict' }, 409) : undefined;
    const user = userEvent.setup();
    await mountPage({ workspaceId, pulseId: pulseId(2) });
    await user.click(await screen.findByRole('button', { name: 'Queue reminder batch' }));
    await user.click(screen.getByRole('button', { name: 'Confirm queue reminders' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/No reminders were queued/);
    expect(screen.queryByText(/is queued/)).toBeNull();
  });

  it('does not render owner delivery controls or request a summary for a member', async () => {
    net.role = 'member';
    net.pulses = [openPulse({ id: pulseId(2), teamName: 'Platform', submittedCount: null })];
    await mountPage({ workspaceId, pulseId: pulseId(2) });
    await screen.findByRole('article');
    expect(screen.queryByRole('region', { name: 'Notification delivery' })).toBeNull();
    expect(net.calls.some((c) => /notifications\/pulses\//.test(c.path))).toBe(false);
  });

  it('does not show delivery state that is unavailable as zero totals', async () => {
    net.override = (call) =>
      /notifications\/pulses\/[0-9a-f-]+$/.test(call.path)
        ? json({ error: 'unavailable' }, 503)
        : undefined;
    await mountPage({ workspaceId, pulseId: pulseId(2) });
    const section = await screen.findByRole('region', { name: 'Notification delivery' });
    expect(await within(section).findByRole('alert')).toHaveTextContent(/unavailable/);
    expect(within(section).queryByText('Waiting to send')).toBeNull();
  });
});

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const rejected = () => Promise.reject(new TypeError('Failed to fetch'));
async function toStep(user: ReturnType<typeof userEvent.setup>, steps: number) {
  await user.click(await screen.findByRole('button', { name: 'Set up notifications' }));
  for (let index = 0; index < steps; index += 1)
    await user.click(screen.getByRole('button', { name: 'Next' }));
}

describe('unknown outcomes at the transport boundary', () => {
  it('replays the same test request after a rejected fetch and locks the channel meanwhile', async () => {
    net.link = { linked: true, revision: 1, linkedAt: at };
    let attempts = 0;
    net.override = (call) => {
      if (!call.path.endsWith('/notifications/test')) return undefined;
      attempts += 1;
      return attempts === 1 ? rejected() : undefined;
    };
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await toStep(user, 2);
    await user.click(screen.getByRole('radio', { name: /My verified sign-in email/ }));
    await user.click(screen.getByRole('button', { name: 'Send a test to me' }));
    await user.click(screen.getByRole('button', { name: 'Confirm send test' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not confirm whether the test/,
    );
    // Another channel cannot be chosen, so no fresh request identity can be created.
    expect(screen.getByRole('radio', { name: /My Slack account/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send a test to me' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Check the test request again' }));
    expect(await screen.findByText(/test message to your own email is queued/)).toBeVisible();
    expect(mutations()).toHaveLength(2);
    expect(mutations()[1]?.body).toEqual(mutations()[0]?.body);
  });

  it('needs a fresh confirmation to test another channel after the owner stops checking', async () => {
    net.link = { linked: true, revision: 1, linkedAt: at };
    let attempts = 0;
    net.override = (call) => {
      if (!call.path.endsWith('/notifications/test')) return undefined;
      attempts += 1;
      return attempts === 1 ? rejected() : undefined;
    };
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await toStep(user, 2);
    await user.click(screen.getByRole('radio', { name: /My verified sign-in email/ }));
    await user.click(screen.getByRole('button', { name: 'Send a test to me' }));
    await user.click(screen.getByRole('button', { name: 'Confirm send test' }));
    await screen.findByRole('button', { name: 'Check the test request again' });
    await user.click(screen.getByRole('button', { name: 'Stop checking' }));
    await user.click(screen.getByRole('radio', { name: /My Slack account/ }));
    await user.click(screen.getByRole('button', { name: 'Send a test to me' }));
    expect(mutations()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Confirm send test' }));
    await waitFor(() => expect(mutations()).toHaveLength(2));
    expect(mutations()[1]?.body).toMatchObject({ channel: 'slack' });
    expect(requestIdOf(1)).not.toBe(requestIdOf(0));
  });

  it('replays a reminder batch after a rejected fetch instead of generating a new request', async () => {
    net.pulses = [openPulse({ id: pulseId(2), teamName: 'Platform', submittedCount: 1 })];
    let attempts = 0;
    net.override = (call) => {
      if (!call.path.endsWith('/remind')) return undefined;
      attempts += 1;
      return attempts === 1 ? rejected() : undefined;
    };
    const user = userEvent.setup();
    await mountPage({ workspaceId, pulseId: pulseId(2) });
    await user.click(await screen.findByRole('button', { name: 'Queue reminder batch' }));
    await user.click(screen.getByRole('button', { name: 'Confirm queue reminders' }));
    await user.click(await screen.findByRole('button', { name: 'Check the request again' }));
    expect(await screen.findByText(/reminder batch is queued/)).toBeVisible();
    expect(mutations()).toHaveLength(2);
    expect(mutations()[1]?.body).toEqual(mutations()[0]?.body);
  });

  it('treats a rejected enable as unconfirmed and says so', async () => {
    net.override = (call) => (call.method === 'PATCH' ? rejected() : undefined);
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await toStep(user, 3);
    await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
    await user.click(screen.getByRole('button', { name: 'Confirm enable notifications' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /could not confirm whether notifications were enabled/,
    );
  });
});

describe('unknown test across a policy revision change', () => {
  async function unknownThenOtherOwnerChange(user: ReturnType<typeof userEvent.setup>) {
    let attempts = 0;
    net.override = (call) => {
      if (!call.path.endsWith('/notifications/test')) return undefined;
      attempts += 1;
      return attempts === 1 ? rejected() : undefined;
    };
    await mountPage({ workspaceId });
    await toStep(user, 2);
    await user.click(screen.getByRole('radio', { name: /My verified sign-in email/ }));
    await user.click(screen.getByRole('button', { name: 'Send a test to me' }));
    await user.click(screen.getByRole('button', { name: 'Confirm send test' }));
    await screen.findByRole('button', { name: 'Check the test request again' });
    net.policy = { ...disabledPolicy, revision: 1, firstReminderHours: 100 };
    await user.click(screen.getByRole('button', { name: 'Refresh notification status' }));
    await screen.findByText(/changed elsewhere after you opened setup/);
  }

  it('still replays the retained request after the policy revision moved', async () => {
    const user = userEvent.setup();
    await unknownThenOtherOwnerChange(user);
    // A brand-new test stays fenced, but the retained one replays verbatim (revision 0).
    expect(screen.getByRole('button', { name: 'Send a test to me' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    await user.click(screen.getByRole('button', { name: 'Check the test request again' }));
    expect(await screen.findByText(/test message to your own email is queued/)).toBeVisible();
    expect(mutations()).toHaveLength(2);
    expect(mutations()[1]?.body).toEqual(mutations()[0]?.body);
    expect(mutations()[1]?.body).toMatchObject({ revision: 0 });
  });

  it('keeps the unknown request through Reload instead of abandoning it silently', async () => {
    const user = userEvent.setup();
    await unknownThenOtherOwnerChange(user);
    await user.click(screen.getByRole('button', { name: 'Reload current settings' }));
    expect(screen.queryByText(/changed elsewhere after you opened setup/)).toBeNull();
    expect(screen.getByRole('radio', { name: /My Slack account/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Check the test request again' }));
    expect(await screen.findByText(/test message to your own email is queued/)).toBeVisible();
    expect(mutations()).toHaveLength(2);
    expect(mutations()[1]?.body).toEqual(mutations()[0]?.body);
    // The draft was rebased onto the other owner's settings, and new requests use the new revision.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText(/First reminder after/)).toHaveValue('100');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('radio', { name: /My verified sign-in email/ }));
    await user.click(screen.getByRole('button', { name: 'Send a test to me' }));
    await user.click(screen.getByRole('button', { name: 'Confirm send test' }));
    await waitFor(() => expect(mutations()).toHaveLength(3));
    expect(mutations()[2]?.body).toMatchObject({ revision: 1 });
    expect(requestIdOf(2)).not.toBe(requestIdOf(0));
  });
});

describe('wizard revision and consent fences', () => {
  it('never rebases an old draft onto a policy another owner changed', async () => {
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await toStep(user, 3);
    net.policy = { ...disabledPolicy, revision: 1, firstReminderHours: 100 };
    await user.click(screen.getByRole('button', { name: 'Refresh notification status' }));
    expect(await screen.findByText(/changed elsewhere after you opened setup/)).toBeVisible();
    const enable = screen.getByRole('button', { name: 'Enable notifications' });
    expect(enable).toHaveAttribute('aria-disabled', 'true');
    await user.click(enable);
    expect(screen.queryByRole('button', { name: 'Confirm enable notifications' })).toBeNull();
    expect(mutations()).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Reload current settings' }));
    expect(screen.getByLabelText(/First reminder after/)).toHaveValue('100');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
    await user.click(screen.getByRole('button', { name: 'Confirm enable notifications' }));
    await screen.findByRole('heading', { name: 'Notifications are enabled' });
    expect(mutations()[0]?.body).toMatchObject({ revision: 1, firstReminderHours: 100 });
  });

  it('does not carry uncertain-retry consent into a later request', async () => {
    net.pulses = [openPulse({ id: pulseId(2), teamName: 'Platform', submittedCount: 1 })];
    net.summary = {
      counts: { ...zeroCounts, failed: 1, uncertain: 2 },
      remindersEnabled: false,
      revision: 7,
    };
    const user = userEvent.setup();
    await mountPage({ workspaceId, pulseId: pulseId(2) });
    const section = await screen.findByRole('region', { name: 'Notification delivery' });
    await user.click(
      await within(section).findByRole('button', { name: 'Retry failed deliveries' }),
    );
    await user.click(screen.getByRole('checkbox', { name: /outcome is unknown/ }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    // Reopening starts unchecked.
    await user.click(screen.getByRole('button', { name: 'Retry failed deliveries' }));
    expect(screen.getByRole('checkbox', { name: /outcome is unknown/ })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: /outcome is unknown/ }));
    // The uncertain total disappears while the consent is ticked: the warning is gone too.
    net.summary = { ...net.summary, counts: { ...zeroCounts, failed: 1 }, revision: 8 };
    await user.click(within(section).getByRole('button', { name: 'Refresh delivery status' }));
    await waitFor(() =>
      expect(within(section).getByText('Outcome unknown').closest('div')).toHaveTextContent(
        /Outcome unknown\s*0/,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole('checkbox', { name: /outcome is unknown/ })).toBeNull(),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm retry' }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    expect(mutations()[0]?.body).not.toHaveProperty('confirmUncertain');
  });
});

describe('own link without operator configuration', () => {
  it('still shows and removes an existing link but offers no new linking', async () => {
    net.role = 'member';
    net.availability = { emailConfigured: false, slackConfigured: false, linkingConfigured: false };
    net.link = { linked: true, revision: 4, linkedAt: at };
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    expect(await screen.findByText(/Slack account linked on 2026-10-13/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Link Slack account' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Unlink Slack account' }));
    net.link = { linked: false, revision: 5, linkedAt: null };
    await user.click(screen.getByRole('button', { name: 'Confirm unlink Slack' }));
    expect(await screen.findByText(/Slack unlinked/)).toBeVisible();
    expect(mutations()).toEqual([
      {
        method: 'POST',
        path: `/api/workspaces/${workspaceId}/notifications/slack-link/unlink`,
        body: { revision: 4 },
      },
    ]);
    await screen.findByText(/Slack linking is not available for this workspace/);
    expect(screen.queryByRole('button', { name: 'Link Slack account' })).toBeNull();
  });
});

describe('focus after closing setup', () => {
  it('returns to the set up button while disabled', async () => {
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await toStep(user, 0);
    await user.click(screen.getByRole('button', { name: 'Close setup' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Set up notifications' })).toHaveFocus(),
    );
  });

  it('returns to the stable Owner settings heading when enabled settings are changed and closed', async () => {
    net.policy = { ...disabledPolicy, enabled: true, revision: 3 };
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await user.click(await screen.findByRole('button', { name: 'Change notification settings' }));
    await user.click(screen.getByRole('button', { name: 'Close setup' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Owner settings' })).toHaveFocus(),
    );
  });

  it('returns to the heading after Done once enabling removed the trigger', async () => {
    const user = userEvent.setup();
    await mountPage({ workspaceId });
    await toStep(user, 3);
    await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
    net.policy = { ...disabledPolicy, enabled: true, revision: 1 };
    await user.click(screen.getByRole('button', { name: 'Confirm enable notifications' }));
    await screen.findByRole('heading', { name: 'Notifications are enabled' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Set up notifications' })).toBeNull(),
    );
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Owner settings' })).toHaveFocus(),
    );
  });
});

describe('late results after access changes', () => {
  async function pendingEnable(user: ReturnType<typeof userEvent.setup>) {
    const hold = deferred();
    net.hold = new Map([
      [`PATCH /api/workspaces/${workspaceId}/notifications/policy`, hold.promise],
    ]);
    await mountPage({ workspaceId });
    await toStep(user, 3);
    await user.click(screen.getByRole('button', { name: 'Enable notifications' }));
    await user.click(screen.getByRole('button', { name: 'Confirm enable notifications' }));
    await waitFor(() => expect(mutations()).toHaveLength(1));
    return hold;
  }
  const lateSuccess = () => json({ policy: { ...disabledPolicy, enabled: true, revision: 1 } });

  it('drops an enable that completes after the owner was demoted to member', async () => {
    const user = userEvent.setup();
    const hold = await pendingEnable(user);
    net.role = 'member';
    // A refresh now hits the owner-only policy read: 403 triggers real membership revalidation.
    await user.click(screen.getByRole('button', { name: 'Refresh notification status' }));
    await waitFor(() =>
      expect(screen.getByText(/Your access to Engineering changed/)).toBeVisible(),
    );
    await act(async () => {
      hold.resolve(lateSuccess());
      await wait(10);
    });
    expect(screen.queryByRole('heading', { name: 'Notifications are enabled' })).toBeNull();
    expect(screen.queryByText('Owner settings')).toBeNull();
    expect(screen.queryByText(/Notifications are enabled for pulses/)).toBeNull();
  });

  it('drops an enable that completes after membership was lost', async () => {
    const user = userEvent.setup();
    const hold = await pendingEnable(user);
    net.listed = false;
    await user.click(screen.getByRole('button', { name: 'Refresh notification status' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Pulse notifications' })).toBeNull(),
    );
    await act(async () => {
      hold.resolve(lateSuccess());
      await wait(10);
    });
    expect(screen.queryByRole('heading', { name: 'Notifications are enabled' })).toBeNull();
    expect(screen.queryByText('Owner settings')).toBeNull();
  });

  it('drops an enable whose wizard was closed before the reply', async () => {
    const user = userEvent.setup();
    const hold = await pendingEnable(user);
    await user.click(screen.getByRole('button', { name: 'Close setup' }));
    await act(async () => {
      hold.resolve(lateSuccess());
      await wait(10);
    });
    expect(screen.queryByRole('heading', { name: 'Notifications are enabled' })).toBeNull();
    expect(
      screen.queryByText('Notifications are enabled for pulses opened after they were enabled.'),
    ).toBeNull();
  });
});
