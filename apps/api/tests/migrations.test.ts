import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { loadMigrations } from '../src/db/migrations.ts';

it('rejects SQL files that would otherwise be silently skipped or share migration numbers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'clio-migrations-'));
  const url = pathToFileURL(`${directory}/`);
  try {
    await writeFile(join(directory, '0001_initial.sql'), 'SELECT 1;');
    await writeFile(join(directory, '0002-wrong.sql'), 'SELECT 2;');
    await expect(loadMigrations(url)).rejects.toThrow('Invalid or duplicate');
    await rm(join(directory, '0002-wrong.sql'));
    await writeFile(join(directory, '0001_collision.sql'), 'SELECT 3;');
    await expect(loadMigrations(url)).rejects.toThrow('Invalid or duplicate');
    await rm(join(directory, '0001_collision.sql'));
    await writeFile(join(directory, '0002_next.sql'), 'SELECT 2;');
    expect((await loadMigrations(url)).map((migration) => migration.name)).toEqual([
      '0001_initial.sql',
      '0002_next.sql',
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
