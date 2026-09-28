import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { createAnalyzer } from './ai/openai-compatible.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { openStore } from './db.js';
import { applyAnalysis } from './decision.js';
import { logger } from './logger.js';
import { createQueue } from './queue.js';
import { VOLUME_MARKER, volumeMarkerMissing } from './volume.js';

const config = loadConfig(process.env, resolve(process.cwd(), '../..'));
mkdirSync(config.dataDir, { recursive: true });
// P-09：REQUIRE_VOLUME=1 时卷标记文件必须存在，否则拒绝启动——
// 卷没挂上时数据会静默写到容器临时盘，重新部署后全部丢失。
if (process.env.REQUIRE_VOLUME === '1' && volumeMarkerMissing(config.dataDir)) {
  logger.fatal(
    { dataDir: config.dataDir, marker: VOLUME_MARKER },
    `REQUIRE_VOLUME=1 但 ${config.dataDir}/${VOLUME_MARKER} 不存在：卷未挂载，拒绝启动`,
  );
  process.exit(1);
}
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
    logger.info({ host: config.host, port: config.port }, 'API listening');
    if (config.accessCodeSha256 === null) {
      logger.warn(
        '[security] ACCESS_CODE_SHA256 未配置，/api 当前无鉴权（仅适合本机开发）。公网部署必须配置该变量。',
      );
    }
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
