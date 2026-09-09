import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { createAnalyzer } from './ai/openai-compatible.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openStore } from './db.js';
import { applyAnalysis } from './decision.js';
import { createQueue } from './queue.js';

const config = loadConfig(process.env, resolve(process.cwd(), '../..'));
mkdirSync(config.dataDir, { recursive: true });
const store = openStore(config.dbPath);
const queue = createQueue({
  store,
  config,
  analyzer: createAnalyzer(config),
  onAnalyzed: (id, result) => applyAnalysis(store, id, result),
});
queue.start();

const server = createApp({ store, config, queue }).listen(
  config.port,
  config.host,
  () => {
    console.log(`API listening on ${config.host}:${config.port}`);
  },
);

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  const serverClosed = new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error === undefined) {
        resolveClose();
      } else {
        rejectClose(error);
      }
    });
  });
  await Promise.all([serverClosed, queue.stop()]);
  store.close();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  });
}
