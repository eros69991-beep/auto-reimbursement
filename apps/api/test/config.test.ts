import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { ensureMonthDirs, safePath } from '../src/storage.js';

it('defaults to the local listener and local Vite origins', () => {
  const config = loadConfig({}, process.cwd());

  expect(config.host).toBe('127.0.0.1');
  expect(config.corsOrigins).toEqual([
    'http://127.0.0.1:5173',
    'http://localhost:5173',
    'http://127.0.0.1:5174',
    'http://localhost:5174',
  ]);
});

it('accepts a Railway listener and exact production origins', () => {
  const config = loadConfig(
    {
      HOST: '0.0.0.0',
      CORS_ORIGINS:
        ' https://zidongbx.netlify.app,https://preview.example.com ',
    },
    process.cwd(),
  );

  expect(config.host).toBe('0.0.0.0');
  expect(config.corsOrigins).toEqual([
    'https://zidongbx.netlify.app',
    'https://preview.example.com',
  ]);
});

it.each([
  '',
  'zidongbx.netlify.app',
  'https://zidongbx.netlify.app/path',
  'https://user@example.com',
  'https://*.netlify.app',
])('rejects an invalid configured CORS origin: %s', (value) => {
  expect(() => loadConfig({ CORS_ORIGINS: value }, process.cwd())).toThrow(
    'INVALID_CORS_ORIGINS',
  );
});

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
