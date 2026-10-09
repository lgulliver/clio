export interface AuthConfig {
  secret: string;
  baseUrl: string;
  appOrigin: string;
  githubClientId: string;
  githubClientSecret: string;
  secureCookies: boolean;
}

function origin(value: string, name: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an HTTP origin`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.hostname.includes('*') ||
    (production && url.protocol !== 'https:')
  ) {
    throw new Error(`${name} must be an explicit HTTP origin; production requires HTTPS`);
  }
  return url.origin;
}

export function readAuthConfig(env: NodeJS.ProcessEnv): AuthConfig | null {
  const keys = [
    'AUTH_SECRET',
    'AUTH_BASE_URL',
    'APP_ORIGIN',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
  ] as const;
  if (keys.every((key) => env[key] === undefined)) return null;
  for (const key of keys)
    if (!env[key]?.trim()) throw new Error(`Complete auth configuration required: ${key}`);
  const secret = env.AUTH_SECRET;
  const base = env.AUTH_BASE_URL;
  const app = env.APP_ORIGIN;
  const githubClientId = env.GITHUB_CLIENT_ID;
  const githubClientSecret = env.GITHUB_CLIENT_SECRET;
  if (!secret || !base || !app || !githubClientId || !githubClientSecret)
    throw new Error('Incomplete auth configuration');
  if (secret.length < 32 || secret.trim() !== secret)
    throw new Error('AUTH_SECRET must contain at least 32 random characters');
  const production = env.NODE_ENV === 'production';
  const baseUrl = origin(base, 'AUTH_BASE_URL', production);
  return {
    secret,
    baseUrl,
    appOrigin: origin(app, 'APP_ORIGIN', production),
    githubClientId,
    githubClientSecret,
    secureCookies: production || baseUrl.startsWith('https:'),
  };
}
