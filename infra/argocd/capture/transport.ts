import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { type CaptureConfig, fail, rejectProxy } from './config.ts';
import { cursor, documentLimit, frames, json } from './parser.ts';

export interface CaptureTransport {
  list(signal: AbortSignal): Promise<unknown>;
  watch(resourceVersion: string, signal: AbortSignal): AsyncIterable<unknown>;
}
export function kubectlArguments(config: CaptureConfig, resourceVersion?: string): string[] {
  const parameters = new URLSearchParams({
    fieldSelector: `metadata.name=${config.scope.applicationName}`,
  });
  if (resourceVersion !== undefined) {
    parameters.set('watch', 'true');
    parameters.set('allowWatchBookmarks', 'true');
    parameters.set('timeoutSeconds', '30');
    parameters.set('resourceVersion', cursor(resourceVersion));
  }
  const raw = `/apis/argoproj.io/v1alpha1/namespaces/${config.scope.applicationNamespace}/applications?${parameters}`;
  return [
    '--kubeconfig',
    config.kubeconfig,
    '--context',
    config.context,
    `--request-timeout=${resourceVersion === undefined ? 15 : 35}s`,
    'get',
    '--raw',
    raw,
  ];
}
export function createTransport(
  config: CaptureConfig,
  env: NodeJS.ProcessEnv = process.env,
): CaptureTransport {
  rejectProxy(env);
  async function* output(
    resourceVersion: string | undefined,
    signal: AbortSignal,
  ): AsyncGenerator<Buffer> {
    if (signal.aborted) return;
    const child = spawn(config.kubectlPath, kubectlArguments(config, resourceVersion), {
      shell: false,
      detached: true,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Classify kubectl's HTTP 410 diagnostic without logging private stderr.
    // Only a bounded prefix is held; exec-plugin output cannot grow memory.
    let stderrBytes = 0;
    let stderrPrefix = Buffer.alloc(0);
    child.stderr.on('data', (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) return;
      stderrBytes += chunk.length;
      if (stderrBytes > documentLimit) {
        stop();
        return;
      }
      if (stderrPrefix.length < 4096) {
        stderrPrefix = Buffer.concat([stderrPrefix, chunk.subarray(0, 4096 - stderrPrefix.length)]);
      }
    });
    let expired = false;
    let spawnFailed = false;
    let hasClosed = false;
    child.once('close', () => {
      hasClosed = true;
    });
    child.on('error', () => {
      spawnFailed = true;
    });
    const closed = once(child, 'close').catch(() => undefined);
    const stop = () => {
      if (!hasClosed && child.pid) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
    };
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(
      () => {
        expired = true;
        stop();
      },
      resourceVersion === undefined ? 15000 : 35000,
    );
    try {
      for await (const chunk of child.stdout) {
        if (!Buffer.isBuffer(chunk)) fail('capture_transport');
        yield chunk;
      }
      await closed;
      if (signal.aborted) return;
      if (stderrBytes > documentLimit) fail('capture_stderr_size');
      if (
        resourceVersion !== undefined &&
        child.exitCode !== 0 &&
        /Error from server \((?:Gone|Expired|ResourceExpired)\):/.test(
          stderrPrefix.toString('utf8'),
        )
      )
        fail('capture_cursor_expired');
      if (spawnFailed || expired || child.exitCode !== 0) fail('capture_transport');
    } catch (error) {
      if (!signal.aborted) {
        if (stderrBytes > documentLimit) fail('capture_stderr_size');
        if (
          error instanceof Error &&
          ['capture_cursor_expired', 'capture_stderr_size'].includes(error.message)
        )
          throw error;
        fail('capture_transport');
      }
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      stop();
      await closed;
    }
  }
  return {
    async list(signal) {
      const buffer = Buffer.alloc(documentLimit);
      let size = 0;
      for await (const piece of output(undefined, signal)) {
        size += piece.length;
        if (size > documentLimit) fail('capture_document_size');
        buffer.set(piece, size - piece.length);
      }
      if (signal.aborted) fail('capture_shutdown');
      return json(buffer.subarray(0, size));
    },
    watch(resourceVersion, signal) {
      return frames(output(resourceVersion, signal));
    },
  };
}
