import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('pnpm run start:api serves the Railway health contract', async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'railway-start-'));
  const port = '3187';
  const output = [];
  const child = spawn('pnpm run start:api', {
    cwd: fileURLToPath(root),
    shell: true,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: port,
      DATA_DIR: dataDir,
      CORS_ORIGINS: 'https://zidongbx.netlify.app',
      AI_BASE_URL: '',
      AI_MODEL: '',
      AI_API_KEY: '',
    },
    stdio: 'pipe',
  });
  child.stdout.on('data', (chunk) => output.push(chunk.toString()));
  child.stderr.on('data', (chunk) => output.push(chunk.toString()));
  context.after(async () => {
    if (child.exitCode === null && child.pid !== undefined) {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          stdio: 'ignore',
        });
      } else {
        child.kill('SIGTERM');
      }
    }
    child.stdout.destroy();
    child.stderr.destroy();
    await rm(dataDir, { recursive: true, force: true });
  });

  let response;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      response = await fetch(`http://127.0.0.1:${port}/health`);
      break;
    } catch {
      if (child.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  assert.ok(response, `API did not start within fifteen seconds\n${output.join('')}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});
