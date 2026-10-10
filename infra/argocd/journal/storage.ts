import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export function fail(code: string): never {
  throw new Error(code);
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('journal_corrupt');
  return Object.fromEntries(Object.entries(value));
}
export function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    fail('journal_corrupt');
  return value;
}
export function string(value: unknown): string {
  if (typeof value !== 'string') fail('journal_corrupt');
  return value;
}
export function instant(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
  const millis = Date.parse(value);
  if (
    !match?.[1] ||
    !Number.isFinite(millis) ||
    new Date(millis).toISOString().slice(0, 19) !== match[1]
  )
    fail('journal_chronology');
  return BigInt(millis) * 1000n + BigInt((match[2] ?? '').padEnd(6, '0').slice(3));
}
export async function outsideGit(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path || (await realpath(path)) !== path)
    fail('journal_private_path');
  for (
    let directory = (await lstat(path)).isDirectory() ? path : dirname(path);
    ;
    directory = dirname(directory)
  ) {
    try {
      await lstat(join(directory, '.git'));
      fail('journal_private_path');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (dirname(directory) === directory) break;
  }
}
export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export async function privateDirectory(path: string): Promise<void> {
  await outsideGit(path);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    fail('journal_private_directory');
}
export async function createPrivateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) fail('journal_private_path');
  await outsideGit(dirname(path));
  await mkdir(path, { mode: 0o700 });
  await privateDirectory(path);
  await syncDirectory(dirname(path));
}
export async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function readPrivate(path: string, limit: number, durable = false): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > limit
    )
      fail('journal_private_file');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) fail('journal_private_file');
    if (durable) await file.sync();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    await file.close();
  }
}
export async function writeExclusive(path: string, body: string): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(body, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await syncDirectory(dirname(path));
}
export async function atomicState(
  directory: string,
  value: unknown,
  file: 'state.json' | 'capture-state.json' = 'state.json',
): Promise<void> {
  const pending = join(
    directory,
    file === 'state.json' ? 'state.pending' : 'capture-state.pending',
  );
  // A crash may leave a flushed pending state. It never overrides acknowledged state.
  const handle = await open(
    pending,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o600,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600)
      fail('journal_private_file');
    await handle.truncate(0);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(pending, join(directory, file));
  await syncDirectory(directory);
}
function code(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : null;
}
async function processIdentity(pid: number): Promise<string | null> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).split(' ');
    const start = fields[19];
    if (close < 0 || !start || !/^\d+$/.test(start)) fail('journal_lock_unavailable');
    return start;
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
type LockKind = 'journal' | 'sender' | 'capture';
function lockPath(directory: string, kind: LockKind): string {
  return join(directory, kind === 'journal' ? '.lock' : `.${kind}.lock`);
}
async function reclaim(directory: string, boot: string, kind: LockKind): Promise<void> {
  const lock = lockPath(directory, kind);
  await privateDirectory(lock);
  const names = await readdir(lock);
  if (!names.length) return; // Only a released lock can be empty; prepared claims publish atomically.
  const name = names[0];
  if (names.length !== 1 || !name || !/^owner\.[0-9a-f-]{36}\.json$/.test(name))
    fail('journal_lock_corrupt');
  const owner = object(JSON.parse(await readPrivate(join(lock, name), 4096)));
  const pid = integer(owner.pid, 1, 2147483647);
  const ownerBoot = string(owner.boot);
  const start = string(owner.start);
  if (ownerBoot === boot && (await processIdentity(pid)) === start) fail('journal_locked');
  // Remove only the old immutable nonce. Concurrent reclaimer cannot unlink a new owner.
  try {
    await unlink(join(lock, name));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await rmdir(lock);
  } catch (error) {
    if (!isMissing(error) && code(error) !== 'ENOTEMPTY' && code(error) !== 'EEXIST') throw error;
  }
}
/** Linux PID + boot ID + /proc start ticks, atomically published nonempty lock directory.
 * Unique owner filename makes concurrent stale reclamation safe. No PID reuse guessing.
 */
export async function locked<T>(
  directory: string,
  work: () => Promise<T>,
  kind: LockKind = 'journal',
): Promise<T> {
  await privateDirectory(directory);
  const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
  const start = await processIdentity(process.pid);
  if (!start || !/^[0-9a-f-]{36}$/.test(boot)) fail('journal_lock_unavailable');
  const nonce = randomUUID();
  const name = `owner.${nonce}.json`;
  const claim = join(directory, `.claim-${nonce}`);
  const lock = lockPath(directory, kind);
  await mkdir(claim, { mode: 0o700 });
  await writeExclusive(join(claim, name), JSON.stringify({ pid: process.pid, boot, start }));
  let acquired = false;
  try {
    for (let attempt = 0; attempt < 4 && !acquired; attempt += 1) {
      try {
        await rename(claim, lock);
        acquired = true;
      } catch (error) {
        if (code(error) !== 'ENOTEMPTY' && code(error) !== 'EEXIST') throw error;
        try {
          await reclaim(directory, boot, kind);
        } catch (failure) {
          if (!isMissing(failure)) throw failure;
        }
      }
    }
    if (!acquired) fail('journal_locked');
    await syncDirectory(directory);
    return await work();
  } finally {
    await releaseClaim(acquired ? lock : claim, name, directory);
  }
}

async function releaseClaim(
  ownedDirectory: string,
  name: string,
  directory: string,
): Promise<void> {
  try {
    await unlink(join(ownedDirectory, name));
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  try {
    await rmdir(ownedDirectory);
  } catch (error) {
    if (!isMissing(error) && code(error) !== 'ENOTEMPTY' && code(error) !== 'EEXIST') throw error;
  }
  await syncDirectory(directory);
}
