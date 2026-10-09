import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/settings')({ component: Workspace });

function Workspace() {
  return (
    <section>
      <h1 className="text-3xl font-semibold tracking-tight">Workspace</h1>
      <p className="mt-4 max-w-2xl leading-7 text-slate-600">
        Manage the sources behind your engineering delivery evidence.
      </p>
      <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-8">
        <h2 className="text-xl font-semibold">Connections</h2>
        <p className="mt-3 text-slate-600">
          No sources connected. Provider connections are not available yet.
        </p>
      </div>
    </section>
  );
}
