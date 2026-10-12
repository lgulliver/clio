import { createFileRoute } from '@tanstack/react-router';
import { Overview } from '../features/overview/overview';
import { parseOverviewSearch } from '../features/overview/view-search';

export const Route = createFileRoute('/')({
  validateSearch: parseOverviewSearch,
  component: OverviewRoute,
});
function OverviewRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <Overview
      search={search}
      onSearchChange={(update) => {
        void navigate({ search: update, resetScroll: false });
      }}
    />
  );
}
