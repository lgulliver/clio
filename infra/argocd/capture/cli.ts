import { pathToFileURL } from 'node:url';
import { fail, loadConfig } from './config.ts';
import { runCapture } from './run.ts';

export async function runCli(args: readonly string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== '--config' || !args[1]) fail('capture_arguments');
  const config = await loadConfig(args[1]);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let lastReportAt = 0;
  let lastStatus = '';
  try {
    const result = await runCapture(config, {
      signal: controller.signal,
      progress(value) {
        const now = Date.now();
        const status = `${value.delivery}/${value.acquisition}`;
        if (
          process.stdout.writableNeedDrain ||
          (now - lastReportAt < 1000 && status === lastStatus)
        )
          return;
        lastReportAt = now;
        lastStatus = status;
        process.stdout.write(`${JSON.stringify(value)}\n`);
      },
    });
    if (!process.stdout.writableNeedDrain) process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((error) => {
    const code =
      error instanceof Error && /^(?:capture|journal)_[a-z_]+$/.test(error.message)
        ? error.message
        : 'capture_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
