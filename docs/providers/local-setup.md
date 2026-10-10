# Local provider setup

Mock workflows need no provider registration or credentials. For real GitHub Deployments, follow [the local connection guide](connect-github.md) after provider preparation. Argo transport remains unimplemented; its steps below prepare access only.

For concrete registration, scoped access checks, credential rotation and troubleshooting, follow [preparing real deployment sources](real-sources.md). For a separate practice controller, follow [the optional local Argo sandbox](local-argocd.md). The sandbox does not connect to Clio; GitHub requires the separate local connection workflow.

## GitHub App

Create a separate GitHub App for collection. The existing Clio Local OAuth app remains for sign-in.

1. Open GitHub account settings, Developer settings, GitHub Apps, New GitHub App. Choose a unique name and project homepage. Leave user OAuth authorization and webhooks disabled for the initial polling adapter.
2. Set repository permissions: Deployments read-only. Metadata read-only is mandatory. Leave other repository, organization and account permissions disabled. This initial adapter does not fetch source code or commit history.
3. Install the app only on explicitly selected repositories. GitHub registration/installation and permission grants remain maintainer actions.
4. Generate an app private key. Keep it outside the repository, with owner-only read/write permissions. Do not paste its contents into chat, commit it, or put it in a VITE_ setting.
5. Record app ID, installation ID, selected stable repository ID and production environment names. These identifiers are configuration, not proof of workspace authorization. The local connection binds them through an operator workspace grant and authenticated workspace owner, then verifies installation/account/repository scope.

The adapter receives signing material server-side and requests a short-lived installation token narrowed to repository IDs and Deployments read-only. Provider keys stay in operator-held private files; short-lived tokens stay in memory, never PostgreSQL. Environment names must be explicitly selected; they are not inferred from naming or the production_environment flag.

## Argo CD

Keep GitOps manifest repository and application-source repository distinct. Record Argo CD instance, application UID/name, target production mapping and operation identity. Decide which signal proves consumer exposure before declaring a qualifying deployment.

The adapter slice parses supplied evidence; no notification endpoint or Argo CD polling client exists yet. Do not point Argo CD at Clio's API before the authenticated ingestion slice is implemented. That slice must define credential scope, notification authentication, replay protection, service authorization, history/backfill gaps and durable receipt before acknowledgment.

Synced/Healthy establishes controller reconciliation and health assessments under its configuration. It does not independently prove consumer exposure or application-source commit lineage. Revision-only notification deduplication can hide distinct deployments of the same SHA; Clio requires operation/rollout identity.

## Live acceptance still needed

Assign a workspace/service, repository/application scope and exposure policy. Verify installation access or authenticated Argo CD ingestion against that exact scope. Keep collection credentials separate from login credentials, preserve gap/coverage reporting, and validate reconciled snapshots through the pinned OEMS package before presenting results.
