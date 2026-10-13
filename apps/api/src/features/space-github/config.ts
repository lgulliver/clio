import { createHash } from 'node:crypto';
import { type GitHubConfig, grantFor, readGitHubConfig } from '../github-collection/config.ts';
export const profile = 'pull_requests:read,metadata:read';
export interface SpaceGitHubConfig extends GitHubConfig {
  readonly profile: typeof profile;
}
export function spaceConfig(config: GitHubConfig): SpaceGitHubConfig {
  return Object.freeze({
    ...config,
    profile,
    grants: Object.freeze(
      config.grants.map((grant) =>
        Object.freeze({
          ...grant,
          fingerprint: createHash('sha256')
            .update(
              JSON.stringify({
                profile,
                appId: config.appId,
                workspaceId: grant.workspaceId,
                installationId: grant.installationId,
                accountId: grant.accountId,
                accountType: grant.accountType,
                repositoryIds: grant.repositoryIds,
              }),
            )
            .digest('hex'),
        }),
      ),
    ),
  });
}
export async function readSpaceGitHubConfig(
  env: NodeJS.ProcessEnv,
  deploymentAppId: number | null,
): Promise<SpaceGitHubConfig | null> {
  try {
    if (
      [
        'SPACE_GITHUB_APP_ID',
        'SPACE_GITHUB_APP_PRIVATE_KEY_FILE',
        'SPACE_GITHUB_APP_GRANTS_FILE',
      ].some((key) => !!env[key]?.trim())
    )
      throw new Error('Deprecated configuration');
    const config = await readGitHubConfig({
      GITHUB_APP_ID: env.GITHUB_SPACE_APP_ID,
      GITHUB_APP_PRIVATE_KEY_FILE: env.GITHUB_SPACE_APP_PRIVATE_KEY_FILE,
      GITHUB_APP_GRANTS_FILE: env.GITHUB_SPACE_APP_GRANTS_FILE,
    });
    if (!config) return null;
    if (config.appId === deploymentAppId) throw new Error('Identical Apps');
    return spaceConfig(config);
  } catch {
    throw new Error('Invalid SPACE GitHub configuration');
  }
}
export { grantFor };
