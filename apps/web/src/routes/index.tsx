import { createFileRoute } from '@tanstack/react-router';
import { Overview } from '../features/overview/overview';

export const Route = createFileRoute('/')({ component: Overview });
