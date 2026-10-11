import { describe, expect, it, vi } from 'vitest';
import {
  apiOrigin,
  parseInvitation,
  parseInvitationStatus,
  parseMemberRevocation,
  parseMembers,
  parsePendingInvitations,
  parseRedirect,
  parseServices,
  parseUser,
  request,
} from './api';

describe('browser trust boundary', () => {
  it('accepts the actual disabled-redirect GitHub OAuth response, rejects unsafe destinations', () => {
    expect(
      parseRedirect({
        redirect: false,
        url: 'https://github.com/login/oauth/authorize?client_id=example&state=test',
      }),
    ).toContain('https://github.com/login/oauth/authorize');
    for (const url of [
      'http://github.com/login/oauth/authorize',
      'https://github.com.evil.test/login/oauth/authorize',
      'https://evil@github.com/login/oauth/authorize',
      'https://github.com/login/oauth/authorize/other',
      'javascript:alert(1)',
    ]) {
      expect(() => parseRedirect({ redirect: false, url })).toThrow(
        'The response could not be verified.',
      );
    }
    expect(() => parseRedirect({ url: 'https://github.com/login/oauth/authorize' })).toThrow();
  });
  it('rejects invalid configuration and private/malformed API payloads without echoing them', () => {
    expect(apiOrigin(undefined)).toBe('http://localhost:3000');
    expect(apiOrigin('https://clio.example/')).toBe('https://clio.example');
    for (const origin of [
      'https://secret@example.com',
      'https://example.com/api',
      'ftp://example.com',
      'https://example.com?token=secret',
    ])
      expect(() => apiOrigin(origin)).toThrow('The response could not be verified.');
    expect(() => parseUser({ user: { id: 'private-secret' } })).toThrow(
      'The response could not be verified.',
    );
    expect(() =>
      parseServices(
        {
          services: [
            { id: '11111111-1111-4111-8111-111111111111', name: 'secret', workspaceId: 'other' },
          ],
        },
        'scope',
      ),
    ).toThrow();
    expect(() => parseInvitation({ invitation: { token: 'secret' } }, 'scope')).toThrow();
  });
});

it('bounds access lists, checks workspace/role/status/date, strips private fields', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const member = {
    userId: 'stable',
    name: 'Member',
    email: 'member@example.test',
    role: 'member',
    createdAt: '2026-10-11T00:00:00Z',
    token: 'private',
  };
  expect(parseMembers({ workspaceId, members: [member], hasMore: true }, workspaceId)).toEqual({
    items: [
      {
        userId: 'stable',
        name: 'Member',
        email: 'member@example.test',
        role: 'member',
        createdAt: member.createdAt,
      },
    ],
    hasMore: true,
  });
  for (const payload of [
    { workspaceId: 'other', members: [member], hasMore: false },
    { workspaceId, members: [member] },
    { workspaceId, members: Array.from({ length: 101 }, () => member), hasMore: true },
    { workspaceId, members: [{ ...member, role: 'admin' }], hasMore: false },
    { workspaceId, members: [{ ...member, createdAt: 'bad' }], hasMore: false },
  ])
    expect(() => parseMembers(payload, workspaceId)).toThrow();
  expect(() =>
    parsePendingInvitations(
      {
        workspaceId,
        invitations: [
          {
            id: workspaceId,
            email: member.email,
            status: 'consumed',
            createdAt: member.createdAt,
            expiresAt: member.createdAt,
          },
        ],
        hasMore: false,
      },
      workspaceId,
    ),
  ).toThrow();
});

it('validates page cursors against bounded last items while retaining legacy responses', () => {
  const workspaceId = '11111111-1111-4111-8111-111111111111';
  const members = Array.from({ length: 100 }, (_, index) => ({
    userId: `opaque/${index}`,
    name: 'Member',
    email: 'member@example.test',
    role: 'member',
    createdAt: '2026-10-11T00:00:00Z',
  }));
  const payload = { workspaceId, members, hasMore: true, nextCursor: 'opaque/99' };
  expect(parseMembers(payload, workspaceId).nextCursor).toBe('opaque/99');
  for (const nextCursor of [null, 1, '', 'other', 'opaque/99 ', 'x'.repeat(513)])
    expect(() => parseMembers({ ...payload, nextCursor }, workspaceId)).toThrow();
  expect(() => parseMembers({ ...payload, hasMore: false }, workspaceId)).toThrow();
  expect(() => parseMembers({ ...payload, members: members.slice(0, 99) }, workspaceId)).toThrow();
  expect(
    parseMembers({ workspaceId, members: [], hasMore: false, nextCursor: null }, workspaceId)
      .nextCursor,
  ).toBeNull();
  const invitations = members.map((item, index) => ({
    id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`,
    email: item.email,
    status: 'pending',
    createdAt: item.createdAt,
    expiresAt: item.createdAt,
  }));
  const nextCursor = invitations[99]?.id;
  expect(
    parsePendingInvitations({ workspaceId, invitations, hasMore: true, nextCursor }, workspaceId)
      .nextCursor,
  ).toBe(nextCursor);
  expect(() =>
    parsePendingInvitations(
      { workspaceId, invitations, hasMore: true, nextCursor: 'bad' },
      workspaceId,
    ),
  ).toThrow();
});

it('bounds exact revocation IDs and rejects private or malformed cancellation responses', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  expect(parseMemberRevocation({ cancelledInvitationIds: [id], hasMore: false })).toEqual({
    cancelledInvitationIds: [id],
    hasMore: false,
  });
  for (const value of [
    undefined,
    { cancelledInvitationIds: ['invalid'], hasMore: false },
    { cancelledInvitationIds: [id, id], hasMore: false },
    { cancelledInvitationIds: [id], hasMore: true },
    { cancelledInvitationIds: Array(101).fill(id), hasMore: false },
    { cancelledInvitationIds: [], hasMore: false, token: 'private' },
  ])
    expect(() => parseMemberRevocation(value)).toThrow();
  expect(parseInvitationStatus({ pending: false })).toBe(false);
  for (const value of [{ pending: 'true' }, { pending: true, token: 'private' }, {}])
    expect(() => parseInvitationStatus(value)).toThrow();
});

it('requires verified JSON revocation and preserves empty invitation cancellation responses', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch');
  try {
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ cancelledInvitationIds: [], hasMore: false }), { status: 200 }),
    );
    await expect(
      request('/members/member', parseMemberRevocation, { method: 'DELETE' }),
    ).resolves.toEqual({ cancelledInvitationIds: [], hasMore: false });
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      request('/members/member', parseMemberRevocation, { method: 'DELETE' }),
    ).rejects.toThrow();
    fetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(
      request(
        '/invitations/id',
        (value) => {
          expect(value).toBeUndefined();
        },
        { method: 'DELETE' },
      ),
    ).resolves.toBeUndefined();
    fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ cancelledInvitationIds: [], hasMore: false }), { status: 201 }),
    );
    await expect(
      request('/members/member', parseMemberRevocation, { method: 'DELETE' }),
    ).rejects.toThrow();
  } finally {
    fetch.mockRestore();
  }
});
