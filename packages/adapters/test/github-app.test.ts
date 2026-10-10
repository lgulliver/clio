import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createInstallationToken, githubApiVersion } from '../src/index.ts';
import { object } from '../src/value.ts';
import { observedAt, response, transport } from './fixtures.ts';

// Fictional, ephemeral test key, never a local credential.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
function request(fetch: Parameters<typeof createInstallationToken>[0]['fetch']) {
  return {
    appId: '123',
    privateKey: key,
    installationId: 1,
    repositoryIds: [11, 12, 11],
    clock: () => new Date(observedAt),
    fetch,
  };
}
describe('GitHub App installation scope', () => {
  it('signs RS256, bounds JWT lifetime and requests only selected repositories + deployments read', async () => {
    const mock = transport([
      response({ token: 'fictional-token', expires_at: '2026-01-04T01:00:00Z' }),
    ]);
    await expect(createInstallationToken(request(mock.fetch))).resolves.toEqual({
      token: 'fictional-token',
      expiresAt: '2026-01-04T01:00:00Z',
    });
    const call = mock.calls[0];
    expect(call?.url).toBe('https://api.github.com/app/installations/1/access_tokens');
    expect(call?.init.redirect).toBe('error');
    expect(JSON.parse(String(call?.init.body))).toEqual({
      repository_ids: [11, 12],
      permissions: { deployments: 'read' },
    });
    const headers = new Headers(call?.init.headers);
    expect(headers.get('X-GitHub-Api-Version')).toBe(githubApiVersion);
    expect(headers.get('Content-Type')).toBe('application/json');
    const jwt = headers.get('Authorization')?.slice(7) ?? '';
    const [header, claims, signature] = jwt.split('.');
    const decoded = object(JSON.parse(Buffer.from(claims ?? '', 'base64url').toString()));
    expect(JSON.parse(Buffer.from(header ?? '', 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const now = Date.parse(observedAt) / 1000;
    expect(decoded).toEqual({ iat: now - 60, exp: now + 540, iss: '123' });
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(`${header}.${claims}`),
        publicKey,
        Buffer.from(signature ?? '', 'base64url'),
      ),
    ).toBe(true);
  });
  it.each([[], [0], [-1], [1.2], [Number.MAX_SAFE_INTEGER + 1]].map((ids) => ({ ids })))(
    'rejects invalid repository scope %j before transport',
    async ({ ids }) => {
      const mock = transport([]);
      await expect(
        createInstallationToken({ ...request(mock.fetch), repositoryIds: ids }),
      ).rejects.toThrow();
      expect(mock.calls).toHaveLength(0);
    },
  );
  it.each([
    { token: '', expires_at: '2026-01-04T01:00:00Z' },
    { token: 'fictional-token', expires_at: observedAt },
    { token: 'fictional-token', expires_at: '2026-01-04T00:00:30Z' },
    { token: 'fictional-token', expires_at: '2026-01-03T00:00:00Z' },
    { token: 'fictional-token', expires_at: 'bad' },
    { token: 42, expires_at: '2026-01-04T01:00:00Z' },
  ])('narrowly validates unknown token response', async (body) => {
    const mock = transport([response(body)]);
    await expect(createInstallationToken(request(mock.fetch))).rejects.toThrow(
      'invalid_token_response',
    );
  });
  it('redacts provider errors, transport exceptions and signing errors', async () => {
    const mock = transport([response({ message: 'secret-in-provider-error' }, {}, 403)]);
    await expect(createInstallationToken(request(mock.fetch))).rejects.toThrow(/^token_http_403$/);
    await expect(
      createInstallationToken(
        request(async () => {
          throw new Error('secret-in-transport');
        }),
      ),
    ).rejects.toThrow(/^token_transport_failed$/);
    await expect(
      createInstallationToken({ ...request(mock.fetch), privateKey: 'secret-bad-key' }),
    ).rejects.toThrow(/^invalid_app_signing_key$/);
  });
  it('rejects non-RSA keys', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    await expect(
      createInstallationToken({ ...request(transport([]).fetch), privateKey: ec }),
    ).rejects.toThrow('invalid_app_signing_key');
  });
  it('reports cancellation without exposing transport exception', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      createInstallationToken({
        ...request(async () => {
          throw new Error('secret');
        }),
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
  });
});
