import { constants } from 'node:fs';
import { access, lstat, open, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

export async function readPrivateFile(path: string, maxBytes: number): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Invalid private file');
  const resolved = await realpath(path);
  if (resolved !== path) throw new Error('Invalid private file');
  // Reject files in any Git checkout, including this isolated writer worktree.
  for (let directory = dirname(resolved); ; directory = dirname(directory)) {
    let checkout = false;
    try {
      const gitPath = join(directory, '.git');
      const git = await lstat(gitPath);
      if (git.isDirectory()) {
        await access(join(gitPath, 'HEAD'));
        checkout = true;
      } else if (git.isFile() && git.size < 4096)
        checkout = (await readFile(gitPath, 'utf8')).startsWith('gitdir: ');
    } catch {}
    if (checkout) throw new Error('Invalid private file');
    if (dirname(directory) === directory) break;
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0 ||
      stat.size < 1 ||
      stat.size > maxBytes
    )
      throw new Error('Invalid private file');
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error('Invalid private file');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}
