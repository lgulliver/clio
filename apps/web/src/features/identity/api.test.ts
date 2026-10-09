import { describe, expect, it } from 'vitest';
import { apiOrigin, parseInvitation, parseRedirect, parseServices, parseUser } from './api';

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
