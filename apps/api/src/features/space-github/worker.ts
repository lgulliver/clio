import { performance } from 'node:perf_hooks';
import {
  AdapterError,
  GitHubRateLimitError,
  parsePullCheckpoint,
  pullFailureCheckpoint,
} from '@clio/adapters';
import type { Pool } from 'pg';
import { abortable } from '../github-collection/deadline.ts';
import {
  acquireQuota,
  type QuotaLease,
  QuotaUnavailable,
  quotaRetryDelay,
  releaseQuota,
  retryDelay,
} from '../github-collection/quota.ts';
import { calculateSignals } from './calculate.ts';
import { terminalizePullCheckpoint } from './checkpoint.ts';
import { grantFor, type SpaceGitHubConfig } from './config.ts';
import { instantMicros } from './input.ts';
import { createSpaceGitHubJobs, JobLost } from './jobs.ts';
import {
  createSliceTransport,
  createSpaceGitHubProvider,
  type SliceBudget,
  type SpaceGitHubProvider,
} from './provider.ts';
import { contextFrom } from './repository.ts';
export async function processOneSpaceGitHub(
  pool: Pool,
  config: SpaceGitHubConfig | null,
  dependencies: {
    signal?: AbortSignal;
    provider?: SpaceGitHubProvider;
    configNow?: () => SpaceGitHubConfig | null;
  } = {},
): Promise<boolean> {
  if (dependencies.signal?.aborted) return false;
  const configNow = dependencies.configNow ?? (() => config),
    jobs = createSpaceGitHubJobs(pool, configNow),
    claim = await jobs.claim();
  if (!claim) return false;
  const start = performance.now(),
    startedAt = claim.claimedAt;
  const clock = () =>
    new Date(Date.parse(claim.claimedAt) + Math.max(0, Math.floor(performance.now() - start)));
  let quota: QuotaLease | undefined, budget: SliceBudget | undefined;
  let checkpoint: ReturnType<typeof parsePullCheckpoint> | null = null;
  let storedInvalid = false;
  let spent = 0;
  let expectedSource:
    | { repositoryId: number; repositoryOwner: string; repositoryName: string }
    | undefined;
  const timeout = AbortSignal.timeout(60000);
  let signal = dependencies.signal ? AbortSignal.any([dependencies.signal, timeout]) : timeout;
  const provider = dependencies.provider ?? createSpaceGitHubProvider(pool);
  try {
    const row = await jobs.preflight(claim);
    storedInvalid = true;
    const context = contextFrom(row.context);
    if (instantMicros(context.windowEnd) > instantMicros(claim.claimedAt))
      throw new Error('Invalid stored window');
    checkpoint = row.checkpoint === null ? null : parsePullCheckpoint(row.checkpoint);
    if (
      checkpoint &&
      (checkpoint.repositoryId !== context.repositoryId ||
        `${checkpoint.repositoryOwner}/${checkpoint.repositoryName}` !== context.repositoryLabel)
    )
      throw new Error('Invalid stored checkpoint scope');
    spent = Number(row.active_millis);
    if (!Number.isSafeInteger(spent) || spent < 0 || spent > 1800000)
      throw new Error('Invalid stored active time');
    signal = AbortSignal.any([
      signal,
      AbortSignal.timeout(Math.max(1, 1800000 - spent - elapsed())),
    ]);
    storedInvalid = false;
    if (spent >= 1800000) {
      await jobs.finish(claim, {
        checkpoint,
        activeMillis: elapsed(),
        startedAt,
        endedAt: clock().toISOString(),
        done: false,
      });
      return true;
    }
    const current = configNow(),
      grant = grantFor(current, context.workspaceId, context.installationId, context.repositoryId);
    if (!current || !grant) throw new JobLost();
    quota = await acquireQuota(pool, context.appId, context.installationId);
    const deadline = new Date(
      clock().getTime() +
        Math.max(0, Math.min(60000, 1800000 - spent) - (performance.now() - start)),
    );
    budget = createSliceTransport(pool, quota, signal, deadline, clock);
    const scope = await abortable(
      provider.verify({
        config: current,
        grant,
        repositoryId: context.repositoryId,
        clock,
        signal,
        fetch: budget.fetch,
      }),
      signal,
    );
    expectedSource = {
      repositoryId: context.repositoryId,
      repositoryOwner: scope.accountLogin,
      repositoryName: scope.repositoryName,
    };
    // Recheck after quota wait/verification without fabricating browser identity.
    await jobs.preflight(claim, {
      activeMillis: elapsed(),
      startedAt,
      endedAt: clock().toISOString(),
    });
    if (
      checkpoint &&
      (checkpoint.repositoryOwner !== scope.accountLogin ||
        checkpoint.repositoryName !== scope.repositoryName)
    ) {
      // Transfers/renames cannot mix two identities in one acquired population.
      await jobs.finish(claim, {
        checkpoint,
        activeMillis: elapsed(),
        startedAt,
        endedAt: clock().toISOString(),
        done: false,
        failure: 'invalid_provider_data',
      });
      return true;
    }
    const remainingRequests = Math.max(0, 40 - budget.requests);
    const slice = await abortable(
      provider.collect({
        verified: {
          repositoryId: context.repositoryId,
          repositoryOwner: scope.accountLogin,
          repositoryName: scope.repositoryName,
          token: scope.token,
        },
        window: context,
        checkpoint,
        activeMillis: Number(row.active_millis) + elapsed(),
        fetch: budget.fetch,
        clock,
        signal,
        remainingRequests,
        deadline,
      }),
      signal,
    );
    const proposed = parsePullCheckpoint(slice.checkpoint);
    if (
      proposed.repositoryId !== context.repositoryId ||
      proposed.repositoryOwner !== scope.accountLogin ||
      proposed.repositoryName !== scope.repositoryName ||
      typeof slice.done !== 'boolean' ||
      !Number.isSafeInteger(slice.requests) ||
      slice.requests < 0 ||
      slice.requests > remainingRequests ||
      !Number.isSafeInteger(slice.activeMillis) ||
      slice.activeMillis < 0 ||
      slice.activeMillis > 60000 ||
      slice.done !== (proposed.phase === 'ready')
    )
      throw new AdapterError('invalid_provider_slice');
    checkpoint = proposed;
    storedInvalid = true;
    calculateSignals(checkpoint, {
      windowStart: context.windowStart,
      windowEnd: context.windowEnd,
    });
    storedInvalid = false;
    if (spent + elapsed() >= 1800000) checkpoint = terminalizePullCheckpoint(checkpoint);
    await jobs.finish(claim, {
      checkpoint,
      activeMillis: elapsed(),
      startedAt,
      endedAt: clock().toISOString(),
      done: checkpoint.phase === 'ready',
    });
  } catch (error) {
    if (error instanceof JobLost) return true;
    let carried: ReturnType<typeof parsePullCheckpoint> | null = null;
    try {
      carried = pullFailureCheckpoint(error);
    } catch {
      storedInvalid = true;
    }
    if (carried) {
      if (
        expectedSource &&
        carried.repositoryId === expectedSource.repositoryId &&
        carried.repositoryOwner === expectedSource.repositoryOwner &&
        carried.repositoryName === expectedSource.repositoryName
      )
        checkpoint = carried;
      else storedInvalid = true;
    }
    const cooperative =
      error instanceof QuotaUnavailable ||
      budget?.yielded ||
      signal.aborted ||
      error instanceof GitHubRateLimitError;
    const revoked =
      error instanceof AdapterError &&
      /^(?:(?:github|token)_http_(?:401|403|404)|github_(?:permissions|installation|repository_scope)_mismatch)$/.test(
        error.code,
      );
    const invalid =
      storedInvalid ||
      (!cooperative &&
        !revoked &&
        error instanceof AdapterError &&
        !/^(?:(?:github|token)_http_5\d\d|(?:token_)?transport_failed|transport_timeout)$/.test(
          error.code,
        ));
    let retryable = !cooperative && !invalid && !revoked;
    let delay = retryDelay(null);
    try {
      delay = Math.max(
        quota && cooperative ? await quotaRetryDelay(pool, quota) : delay,
        error instanceof GitHubRateLimitError ? (error.retryAfterSeconds ?? 0) : 0,
      );
    } catch {
      retryable = !invalid && !revoked;
    }
    const capped = !invalid && !revoked && spent + elapsed() >= 1800000 && checkpoint !== null;
    if (capped) checkpoint = terminalizePullCheckpoint(checkpoint);
    await jobs.finish(claim, {
      checkpoint,
      activeMillis: elapsed(),
      startedAt,
      endedAt: clock().toISOString(),
      done: capped,
      ...(invalid
        ? { failure: 'invalid_provider_data' as const }
        : revoked
          ? { failure: 'provider_unavailable' as const }
          : {}),
      retryable: capped ? false : retryable,
      delaySeconds: delay,
    });
  } finally {
    if (quota) await releaseQuota(pool, quota);
  }
  return true;
  function elapsed() {
    return Math.max(0, Math.ceil(performance.now() - start));
  }
}
