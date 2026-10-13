import { createFileRoute, useLocation } from '@tanstack/react-router';
import { useEffect } from 'react';
import { parseNotificationSearch } from '../features/notifications/view-search';
import { DeveloperExperiencePage } from '../features/space/space-page';

export const Route = createFileRoute('/developer-experience')({
  validateSearch: parseNotificationSearch,
  component: DeveloperExperienceRoute,
});
function DeveloperExperienceRoute() {
  // The router merges validated keys over the raw query, so allowlist again before use.
  const raw = Route.useSearch();
  const { workspace, pulse, notificationLink } = parseNotificationSearch(raw);
  const navigate = Route.useNavigate();
  const navigationKey = useLocation({ select: (location) => location.state.__TSR_key });
  const extra = Object.keys(raw).length;
  const kept = [workspace, pulse, notificationLink].filter(Boolean).length;
  useEffect(() => {
    // Remove rejected or unknown keys, including a malformed pair, from the address bar.
    if (extra === kept) return;
    void navigate({
      search: {
        ...(workspace ? { workspace } : {}),
        ...(pulse ? { pulse } : {}),
        ...(notificationLink ? { notificationLink } : {}),
      },
      replace: true,
    });
  }, [extra, kept, workspace, pulse, notificationLink, navigate]);
  return (
    <DeveloperExperiencePage
      {...(workspace
        ? { initialTarget: { workspaceId: workspace, ...(pulse ? { pulseId: pulse } : {}) } }
        : {})}
      {...(notificationLink ? { notificationLink } : {})}
      {...(navigationKey ? { navigationKey } : {})}
      onTargetChange={(target) => {
        void navigate({
          search: target
            ? {
                workspace: target.workspaceId,
                ...(target.pulseId ? { pulse: target.pulseId } : {}),
              }
            : {},
          replace: true,
        });
      }}
    />
  );
}
