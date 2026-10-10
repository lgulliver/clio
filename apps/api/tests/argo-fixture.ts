import { randomUUID } from 'node:crypto';
export function grantFixture(workspaceId: string = randomUUID(), serviceId: string = randomUUID()) {
  return {
    sourceId: randomUUID(),
    workspaceId,
    serviceId,
    instance: 'fixture-instance',
    applicationUid: randomUUID(),
    applicationName: 'guestbook',
    applicationNamespace: 'argocd',
    project: 'default',
    destinationClusterId: 'fixture-cluster',
    destinationServer: 'https://kubernetes.default.svc',
    destinationName: null,
    destinationNamespace: 'guestbook',
    configurationRepositoryId: 'fixture-config-repo',
    repoURL: 'https://example.com/guestbook.git',
    environment: 'production',
  };
}
