import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

let host = '127.0.0.1';
let port = '5173';
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--host') host = args[++index];
  else if (arg === '--port') port = args[++index];
  else if (arg.startsWith('--host=')) host = arg.slice('--host='.length);
  else if (arg.startsWith('--port=')) port = arg.slice('--port='.length);
}

const browserHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
const children = [];

function run(name, command, commandArgs, options) {
  const child = spawn(command, commandArgs, { stdio: 'inherit', ...options });
  child.on('exit', (code) => {
    if (code !== null && code !== 0) console.error(`[dev] ${name} exited with code ${code}`);
  });
  children.push(child);
  return child;
}

// API on its conventional loopback port, loading the repo-root .env for AI credentials.
run('api', process.execPath, [
  '--env-file-if-exists=../../.env',
  '--import',
  'tsx',
  'src/server.ts',
], { cwd: resolve(root, 'apps/api') });

// Web dev server; the app talks to its own origin and Vite proxies /api + /health to the API.
run('web', process.execPath, [
  resolve(root, 'apps/web/node_modules/vite/bin/vite.js'),
  '--host',
  host,
  '--port',
  port,
  '--strictPort',
], {
  cwd: resolve(root, 'apps/web'),
  env: { ...process.env, VITE_API_BASE_URL: `http://${browserHost}:${port}` },
});

function shutdown() {
  for (const child of children) child.kill();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
