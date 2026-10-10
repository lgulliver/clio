import { createPrivateKey, createSign } from 'node:crypto';
import { AdapterError, instant, object, positiveId, string, timestamp } from './value.ts';

export const githubApiVersion = '2026-03-10';
export type FetchTransport = (url: string, init: RequestInit) => Promise<Response>;
export type InstallationToken = Readonly<{ token: string; expiresAt: string }>;

/** Authorization precondition: caller proves workspace owner + installation/repository scope. */
export async function createInstallationToken(input: {
  appId: string;
  privateKey: string;
  installationId: number;
  repositoryIds: readonly number[];
  clock: () => Date;
  fetch: FetchTransport;
  signal?: AbortSignal;
}): Promise<InstallationToken> {
  positiveId(input.installationId);
  string(input.appId);
  if (input.repositoryIds.length === 0 || input.repositoryIds.length > 500) {
    throw new AdapterError('invalid_repository_scope');
  }
  const repositoryIds = [...new Set(input.repositoryIds.map(positiveId))].sort((a, b) => a - b);
  const now = input.clock();
  const seconds = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(seconds)) throw new AdapterError('invalid_clock');
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  // 60-second skew; expiration nine minutes from now, <= 10 minutes from iat.
  const claims = Buffer.from(
    JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: input.appId }),
  ).toString('base64url');
  let jwt: string;
  try {
    const key = createPrivateKey(input.privateKey);
    if (key.asymmetricKeyType !== 'rsa' || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw new AdapterError('invalid_app_signing_key');
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    jwt = `${header}.${claims}.${signer.sign(key).toString('base64url')}`;
  } catch {
    throw new AdapterError('invalid_app_signing_key');
  }
  if (input.signal?.aborted) throw new AdapterError('cancelled');
  let response: Response;
  try {
    response = await input.fetch(
      `https://api.github.com/app/installations/${input.installationId}/access_tokens`,
      {
        method: 'POST',
        redirect: 'error',
        signal: input.signal ?? null,
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': githubApiVersion,
        },
        body: JSON.stringify({
          repository_ids: repositoryIds,
          permissions: { deployments: 'read' },
        }),
      },
    );
  } catch {
    throw new AdapterError(input.signal?.aborted ? 'cancelled' : 'token_transport_failed');
  }
  if (!response.ok) throw new AdapterError(`token_http_${response.status}`);
  try {
    const body = object(await response.json());
    const token = string(body.token);
    const expiresAt = timestamp(body.expires_at);
    if (instant(expiresAt) <= BigInt(input.clock().getTime() + 60_000) * 1000n)
      throw new AdapterError('expired_token');
    return Object.freeze({ token, expiresAt });
  } catch {
    throw new AdapterError('invalid_token_response');
  }
}
