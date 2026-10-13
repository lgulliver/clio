import { AdapterError } from '@clio/adapters';
import { Pool } from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { createSliceTransport, SliceYield } from '../src/features/space-github/provider.ts';

const quota = vi.hoisted(() => ({ pace: vi.fn(async () => {}), observe: vi.fn(async () => {}) }));
vi.mock('../src/features/github-collection/quota.ts', () => ({
  paceQuota: quota.pace,
  observeQuota: quota.observe,
  acquireQuota: vi.fn(),
  releaseQuota: vi.fn(),
}));
const pool = new Pool();
const lease = { appId: 12, installationId: 10, token: 'fixture' };
afterEach(() => {
  vi.useRealTimers();
  quota.pace.mockClear();
  quota.observe.mockClear();
});
it('counts verification and collection in one forty-request budget', async () => {
  const network = vi.fn(async () => Response.json({ ok: true }));
  const budget = createSliceTransport(
    pool,
    lease,
    new AbortController().signal,
    new Date(Date.now() + 60000),
    () => new Date(),
    network,
  );
  for (let i = 0; i < 40; i++)
    await budget.fetch(`https://api.github.com/${i < 5 ? 'app' : 'repos/fixture/repo'}`, {});
  await expect(
    budget.fetch('https://api.github.com/repos/fixture/repo', {}),
  ).rejects.toBeInstanceOf(SliceYield);
  expect(network).toHaveBeenCalledTimes(40);
  expect(budget.requests).toBe(40);
  expect(budget.yielded).toBe(true);
  expect(quota.observe.mock.calls.length).toBe(40);
});
it('rechecks original deadline after pacing before sending HTTP', async () => {
  let now = new Date('2026-10-13T12:00:00Z');
  quota.pace.mockImplementationOnce(async () => {
    now = new Date('2026-10-13T12:01:01Z');
  });
  const network = vi.fn(async () => Response.json({}));
  const budget = createSliceTransport(
    pool,
    lease,
    new AbortController().signal,
    new Date('2026-10-13T12:01:00Z'),
    () => now,
    network,
  );
  await expect(budget.fetch('https://api.github.com/app', {})).rejects.toBeInstanceOf(SliceYield);
  expect(network).not.toHaveBeenCalled();
  expect(budget.requests).toBe(0);
});
it('caps individual response at exactly 2,000,000 bytes', async () => {
  const budget = createSliceTransport(
    pool,
    lease,
    new AbortController().signal,
    new Date(Date.now() + 60000),
    () => new Date(),
    async () => new Response('x'.repeat(2000001)),
  );
  await expect(budget.fetch('https://api.github.com/app', {})).rejects.toMatchObject({
    code: 'response_too_large',
  });
  expect(budget.requests).toBe(1);
  const allowed = createSliceTransport(
    pool,
    lease,
    new AbortController().signal,
    new Date(Date.now() + 60000),
    () => new Date(),
    async () => new Response('x'.repeat(2000000)),
  );
  expect((await (await allowed.fetch('https://api.github.com/app', {})).text()).length).toBe(
    2000000,
  );
});
it('bounds non-cooperative fetch at ten seconds', async () => {
  vi.useFakeTimers();
  const budget = createSliceTransport(
    pool,
    lease,
    new AbortController().signal,
    new Date(Date.now() + 60000),
    () => new Date(),
    () => new Promise<Response>(() => {}),
  );
  const request = budget.fetch('https://api.github.com/app', {});
  const checked = expect(request).rejects.toBeInstanceOf(AdapterError);
  await vi.advanceTimersByTimeAsync(10000);
  await checked;
});
