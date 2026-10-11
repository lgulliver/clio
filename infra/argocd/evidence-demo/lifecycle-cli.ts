import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildLifecycleReports, lifecycleCapabilities } from './lifecycle-measurement.ts';

async function ancestors(path: string, outsideGit = false): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error('invalid_lifecycle_path');
  for (let current = path; ; current = dirname(current)) {
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid_lifecycle_path');
    if (outsideGit) {
      try {
        await lstat(join(current, '.git'));
        throw new Error('lifecycle_output_inside_git');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    if (dirname(current) === current) return;
  }
}
/** Existing readJson uses stat then unbounded readFile. Here opened descriptor bounds actual read. */
async function readBoundedJson(path: string): Promise<unknown> {
  await ancestors(dirname(path));
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
    throw new Error('invalid_lifecycle_json');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.size > 65536) throw new Error('invalid_lifecycle_json');
    const bytes = Buffer.alloc(65537);
    let size = 0;
    while (size < bytes.length) {
      const next = await file.read(bytes, size, bytes.length - size, null);
      if (next.bytesRead === 0) break;
      size += next.bytesRead;
    }
    if (size > 65536) throw new Error('invalid_lifecycle_json');
    const value: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)),
    );
    return value;
  } finally {
    await file.close();
  }
}
export async function runLifecycleCli(args: readonly string[]): Promise<string[]> {
  const [ledgerFile, basisFile, producersFile, outputDirectory, reviewFile] = args;
  if (
    (args.length !== 4 && args.length !== 5) ||
    !ledgerFile ||
    !basisFile ||
    !producersFile ||
    !outputDirectory
  )
    throw new Error(
      'usage: lifecycle-cli.ts LEDGER_JSON BASIS_JSON PRODUCERS_JSON OUTPUT_DIR [REVIEW_JSON]',
    );
  if (!isAbsolute(outputDirectory) || resolve(outputDirectory) !== outputDirectory)
    throw new Error('invalid_lifecycle_path');
  await ancestors(dirname(outputDirectory), true);
  const [ledger, basis, producers, review] = await Promise.all([
    readBoundedJson(resolve(ledgerFile)),
    readBoundedJson(resolve(basisFile)),
    readBoundedJson(resolve(producersFile)),
    reviewFile ? readBoundedJson(resolve(reviewFile)) : undefined,
  ]);
  const eventIds = Object.fromEntries(
    lifecycleCapabilities.map((capability) => [capability, randomUUID()]),
  );
  const reports = buildLifecycleReports(ledger, basis, producers, eventIds, review);
  await mkdir(outputDirectory, { recursive: false, mode: 0o700 });
  await ancestors(outputDirectory, true);
  const paths: string[] = [];
  for (const report of reports) {
    const path = join(outputDirectory, `${report.capability}.json`);
    const file = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    } finally {
      await file.close();
    }
    paths.push(path);
  }
  return paths;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    for (const path of await runLifecycleCli(process.argv.slice(2))) console.log(path);
  } catch (error) {
    const code =
      error instanceof Error &&
      /^(measurement|lifecycle|invalid_lifecycle)_[a-z_]+$/.test(error.message)
        ? error.message
        : 'lifecycle_report_failed';
    console.error(code);
    process.exitCode = 1;
  }
}
