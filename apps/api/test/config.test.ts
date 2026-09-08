import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ensureMonthDirs, safePath } from '../src/storage.js';

it('creates local month folders and never accepts traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reimburse-config-'));
  try {
    const config = loadConfig({ DATA_DIR: root }, root);
    const dirs = await ensureMonthDirs(config.dataDir, '2026-09');

    expect((await stat(dirs.originals)).isDirectory()).toBe(true);
    expect(config.ai).toBeNull();
    expect(config.concurrency).toBe(4);
    expect(() => safePath(root, '../secret')).toThrow('UNSAFE_PATH');
    expect(() => loadConfig({ PORT: 'NaN' }, root)).toThrow('INVALID_PORT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
