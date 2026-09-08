import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openStore } from './db.js';

const config = loadConfig(process.env, resolve(process.cwd(), '../..'));
mkdirSync(config.dataDir, { recursive: true });
const store = openStore(config.dbPath);

const server = createApp({ store, config }).listen(config.port, config.host, () => {
  console.log(`API listening on ${config.host}:${config.port}`);
});

server.once('close', () => {
  store.close();
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close();
  });
}
