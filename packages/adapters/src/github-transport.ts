import type { FetchTransport } from './github-app.ts';
import { AdapterError, positiveId } from './value.ts';

/** Buffer within one deadline so every returned native Response body method is local. */
export function createBoundedGitHubTransport(input: {
  fetch: FetchTransport;
  timeoutMs?: number;
  maxBytes?: number;
}): FetchTransport {
  const timeoutMs = positiveId(input.timeoutMs ?? 10_000);
  const maxBytes = positiveId(input.maxBytes ?? 2_000_000);
  if (timeoutMs > 2_147_483_647) throw new AdapterError('invalid_timeout');
  return async (url, init) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new AdapterError('unsafe_github_url');
    }
    if (
      target.origin !== 'https://api.github.com' ||
      target.username ||
      target.password ||
      target.hash
    )
      throw new AdapterError('unsafe_github_url');
    const controller = new AbortController();
    const caller = init.signal;
    let failure: AdapterError | undefined;
    let rejectAbort: (error: AdapterError) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    // Attach immediately, including when caller already aborted.
    void aborted.catch(() => {});
    function abort(code: string) {
      if (failure) return;
      failure = new AdapterError(code);
      rejectAbort(failure);
      controller.abort();
    }
    const onAbort = () => abort('cancelled');
    caller?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => abort('transport_timeout'), timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (caller?.aborted) onAbort();
      if (failure) throw failure;
      const response = await Promise.race([
        input.fetch(target.href, { ...init, redirect: 'error', signal: controller.signal }),
        aborted,
      ]);
      if (response.redirected || (response.status >= 300 && response.status < 400))
        throw new AdapterError('unsafe_github_redirect');
      if (response.url && response.url !== target.href)
        throw new AdapterError('unsafe_github_redirect');
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        reader = response.body.getReader();
        while (true) {
          const chunk = await Promise.race([reader.read(), aborted]);
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) throw new AdapterError('transport_failed');
          size += chunk.value.byteLength;
          if (size > maxBytes) throw new AdapterError('response_too_large');
          chunks.push(chunk.value);
        }
      }
      if (failure) throw failure;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new Response(response.body === null ? null : bytes, {
        status: response.status,
        statusText: '',
        headers: response.headers,
      });
    } catch (error) {
      // Only errors generated here are trusted; injected transport errors may contain secrets.
      if (failure) throw failure;
      if (
        error instanceof AdapterError &&
        ['unsafe_github_redirect', 'response_too_large'].includes(error.code)
      )
        throw new AdapterError(error.code);
      throw new AdapterError('transport_failed');
    } finally {
      clearTimeout(timer);
      caller?.removeEventListener('abort', onAbort);
      controller.abort();
      // Cancellation itself can hang on an uncooperative underlying source.
      if (reader) void reader.cancel().catch(() => {});
    }
  };
}
