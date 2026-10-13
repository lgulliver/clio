import { createFileRoute } from '@tanstack/react-router';
import { DeveloperExperiencePage } from '../features/space/space-page';

export const Route = createFileRoute('/developer-experience')({
  component: () => <DeveloperExperiencePage />,
});
