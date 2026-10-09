import { betterAuth } from 'better-auth';
import type { Pool } from 'pg';
import type { AuthConfig } from './config.ts';

export function createAuth(pool: Pool, config: AuthConfig) {
  return betterAuth({
    appName: 'Clio',
    database: pool,
    secret: config.secret,
    baseURL: config.baseUrl,
    basePath: '/api/auth',
    trustedOrigins: [config.appOrigin],
    logger: { disabled: true },
    // Let Clio redact failures before better-call's fallback logs raw SQL errors.
    onAPIError: { throw: true },
    telemetry: { enabled: false },
    databaseHooks: {
      account: {
        create: {
          before: async () => ({
            data: {
              accessToken: null,
              refreshToken: null,
              idToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
            },
          }),
        },
        update: {
          before: async () => ({
            data: {
              accessToken: null,
              refreshToken: null,
              idToken: null,
              accessTokenExpiresAt: null,
              refreshTokenExpiresAt: null,
            },
          }),
        },
      },
    },
    emailAndPassword: { enabled: false },
    socialProviders: {
      github: {
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
        disableDefaultScope: true,
        overrideUserInfoOnSignIn: true,
        scope: ['read:user', 'user:email'],
      },
    },
    user: {
      modelName: 'auth_users',
      fields: {
        emailVerified: 'email_verified',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    session: {
      modelName: 'auth_sessions',
      cookieCache: { enabled: false },
      fields: {
        userId: 'user_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    account: {
      modelName: 'auth_accounts',
      accountLinking: { enabled: false },
      storeAccountCookie: false,
      fields: {
        userId: 'user_id',
        accountId: 'account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      modelName: 'auth_verifications',
      fields: {
        expiresAt: 'expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    advanced: {
      useSecureCookies: config.secureCookies,
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', secure: config.secureCookies },
      disableCSRFCheck: false,
      disableOriginCheck: false,
      trustedProxyHeaders: false,
      ipAddress: { ipAddressHeaders: ['x-clio-client-ip'] },
    },
  });
}
export type ClioAuth = ReturnType<typeof createAuth>;

export function readSession(auth: ClioAuth, headers: Headers) {
  return auth.api.getSession({
    headers,
    query: { disableCookieCache: true },
    returnHeaders: true,
  });
}
