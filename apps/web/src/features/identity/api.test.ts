import { describe, expect, it } from 'vitest';
import {
  apiOrigin,
  parseInvitation,
  parseMembers,
  parsePendingInvitations,
  parseRedirect,
  parseServices,
  parseUser,
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
