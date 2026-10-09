# Clio browser

React SPA with cookie-backed GitHub sign-in, safe `/api/me` identity, workspace selection and creation, workspace-scoped services, and manually shared member invitations. Members read services; owners create services and invitations. No provider connections or metric results exist yet.

Run `pnpm dev` from the repository root. The API defaults to `http://localhost:3000`; optional `VITE_API_URL` must be an HTTP(S) origin without a path, credentials, query or fragment. This value is public. Never add OAuth secrets, database credentials or collection tokens to browser configuration. Configure the API's `APP_ORIGIN` to match the browser origin. GitHub sign-in returns to browser `/settings`.

Identity is checked on mount and visibility changes, and on focus while signed in. Mount and visibility checks hide workspace data. Focus checks run in the background and preserve drafts and invitation tokens for the same user; identity changes, failed checks, hidden-tab transitions and logout clear private state and query caches. Logout failures remain visible because server session revocation cannot be assumed. Workspace selection is in memory only. Invitation tokens appear only in the current workspace UI, can be selected and copied manually, and disappear on workspace/identity changes or dismissal. No browser storage, notification delivery, member listing or revocation UI is implemented.

`/settings?authError=1` shows a generic login failure. Callback search details are discarded from the URL. All API payloads are parsed from unknown and failures are redacted. Only validated HTTPS GitHub OAuth authorization URLs trigger external navigation.

Checks: `pnpm --filter @clio/web build`, `pnpm --filter @clio/web typecheck`, `pnpm --filter @clio/web test`, and `pnpm exec biome check apps/web`. Tests use controlled HTTP responses; they do not perform real GitHub login. Production hosting must serve `index.html` for SPA routes, with credentialed API CORS and cookie configuration appropriate to the selected origins.
