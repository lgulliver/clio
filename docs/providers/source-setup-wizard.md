# Guided source setup

The owner-only wizard in **Workspace → Set up a data source** connects a service to the existing collection workflows. It reads saved server state; it does not provision provider access or store secrets in the browser. Members can read connections and saved results through the existing service controls and Overview.

## Before starting

Start PostgreSQL, apply migrations, start the API and browser, and sign in as a workspace owner. Follow [getting started](../getting-started.md). Each collector needs its own worker; API startup does not process collection jobs.

For GitHub, first follow [the real-source preparation guide](real-sources.md) and [GitHub connection guide](connect-github.md). Your operator configures the separate GitHub App and scoped installation/repository access. Login OAuth is identity-only. The wizard never asks for the App private key or a client secret.

For Argo CD, follow [the connection guide](connect-argocd.md). Your operator grants one exact Application scope and configures native operation delivery. GitOps manifests may live in a different repository from application source; sync success alone does not establish production exposure or application-source lineage. Additional producers and durable capture remain deliberate operator setup.

For a fictional demo, run `pnpm worker:mock`. No live provider access is needed. All mock results remain labelled fictional and provisional.

## Wizard steps

1. **Service:** choose a service in the selected workspace, or create one inside the step. Changing workspace resets the wizard and its in-memory selections.
2. **Source:** choose GitHub Deployments, Argo CD or Fictional demo. Changing source clears progress for the previous source.
3. **Connection:** save the exact source configuration. GitHub uses the selected repository and production environment; Argo uses a granted Application; mock uses fictional mapping settings. Missing operator access, changed grants, unsaved edits and failed saves prevent progress. Saving a connection does not establish complete evidence.
4. **Collection:** choose a closed reporting window for live sources and enqueue collection. The separate worker must save a successful result for the current configuration revision before continuing. Pending, running and failed requests do not qualify. Older successful revisions do not satisfy the current connection. Refresh checks stored state; it does not trigger another collection.
5. **Evidence:** review the requirements for deployment population, change history, outcome classifications and recovery evidence. For real sources, select a successful native basis and received independent reports using the existing measurement controls. Selecting no reports is valid and produces an honest partial measurement. For mock, the wizard explains the fictional coverage limitation.

Back/Next keeps the selected source controls mounted, retaining drafts and collection confirmation state. Unconfirmed requests block advancing beyond configuration or collection and changing the selected service/source; Back remains available. Closing while confirmation is pending asks you to keep setup or leave and check source history before submitting again. Accepted queued jobs and background refresh do not prevent closing. Closing discards local selections and drafts; already saved connections, jobs and results remain in PostgreSQL. Reloading starts a new wizard and reads that persisted state. Secrets are never persisted in browser storage.

## What Finish means

**Finish setup review** closes the wizard. It does not certify coverage or OEMS conformance, declare a measurement complete, or enqueue work automatically. Overview presents saved measurements with their reporting window, evidence cutoffs, coverage, per-metric quality and no-observation states. Native and independent results stay separate.

Complete live metrics require independently supported evidence and the pinned metric-specific conditions. Follow [independent evidence setup](connect-measurement-evidence.md) for private producer configuration. The wizard checklist describes requirements; received reports and saved assessments provide the actual evidence state. Missing evidence remains missing, never zero.
