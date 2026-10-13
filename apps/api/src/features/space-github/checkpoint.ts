import { type PullCheckpoint, parsePullCheckpoint } from '@clio/adapters';
import { instantMicros } from './input.ts';

/** Preserve the last accepted page and its traversal flags when active budget ends. */
export function terminalizePullCheckpoint(value: unknown): PullCheckpoint {
  const checkpoint = parsePullCheckpoint(value);
  const pulls =
    checkpoint.phase === 'discovery'
      ? [...checkpoint.pulls].sort((a, b) => {
          const left = instantMicros(a.createdAt),
            right = instantMicros(b.createdAt);
          return left === right ? b.id - a.id : left > right ? -1 : 1;
        })
      : checkpoint.pulls;
  return parsePullCheckpoint({
    ...checkpoint,
    phase: 'ready',
    nextPullPage: null,
    pulls,
    gaps: [...new Set([...checkpoint.gaps, 'active_time_limit'])],
  });
}
