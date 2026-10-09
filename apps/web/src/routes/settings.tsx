import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { WorkspacePage } from '../features/workspace/workspace-page';

export const Route = createFileRoute('/settings')({
  validateSearch: (search: Record<string, unknown>): { authError?: 1 } =>
    search.authError === 1 || search.authError === '1' ? { authError: 1 } : {},
  component: Settings,
});
function Settings() {
  const { authError } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [loginFailed] = useState(authError === 1);
  useEffect(() => {
    // Discard callback details from the URL; retain only the generic visible outcome.
    void navigate({ search: {}, replace: true });
  }, [navigate]);
  return <WorkspacePage authError={loginFailed} />;
}
