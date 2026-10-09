import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/')({ component: Overview });

function Overview() {
  return (
    <section>
      <p className="text-sm font-medium text-indigo-700">Engineering delivery, made clearer</p>
      <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
        Understand delivery through evidence.
      </h1>
      <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-600">
        Bring deployment, change and incident evidence together to understand how your services
        deliver.
      </p>
      <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-8">
        <h2 className="text-xl font-semibold">No service evidence yet</h2>
        <p className="mt-3 max-w-2xl leading-7 text-slate-600">
          Metrics will appear once a source is connected and its evidence has been checked.
        </p>
        <Link
          to="/settings"
          className="mt-6 inline-flex rounded-lg bg-slate-900 px-5 py-3 text-sm font-medium text-white focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-600"
        >
          View workspace
        </Link>
      </div>
    </section>
  );
}
