import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Analysis } from '@auto-reimbursement/contracts';
import { createApp } from '../apps/api/src/app.ts';
import { AiError, type ReceiptAnalyzer } from '../apps/api/src/ai/types.ts';
import type { Config } from '../apps/api/src/config.ts';
import { openStore } from '../apps/api/src/db.ts';
import { applyAnalysis } from '../apps/api/src/decision.ts';
import { createQueue } from '../apps/api/src/queue.ts';

type Fixture = { file: string; analysis: Analysis | null; failure: 'transient' | 'terminal' | null };

class FakeAnalyzer implements ReceiptAnalyzer {
  private readonly attempts = new Map<string, number>();

  constructor(private readonly fixtures: Map<string, Fixture>) {}

  async analyzeReceipt(image: { bytes: Buffer }): Promise<Analysis> {
    const sha256 = createHash('sha256').update(image.bytes).digest('hex');
    const fixture = this.fixtures.get(sha256);
    if (fixture === undefined) throw new AiError('INVALID_RESPONSE', false);
    const attempts = (this.attempts.get(sha256) ?? 0) + 1;
    this.attempts.set(sha256, attempts);
    if (fixture.failure === 'terminal') throw new AiError('AUTH', false);
    if (fixture.failure === 'transient' && attempts === 1) throw new AiError('UPSTREAM', true);
    if (fixture.analysis === null) throw new AiError('INVALID_RESPONSE', false);
    return fixture.analysis;
  }
}

async function main(): Promise<void> {
const fixtureDirectory = join(process.cwd(), 'e2e', 'fixtures');
const fixtureRows = JSON.parse(await readFile(join(fixtureDirectory, 'manifest.json'), 'utf8')) as Fixture[];
const fixtureMap = new Map<string, Fixture>();
for (const fixture of fixtureRows) {
  const bytes = await readFile(join(fixtureDirectory, 'images', fixture.file));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (!fixtureMap.has(hash)) fixtureMap.set(hash, fixture);
}

const dataDir = await mkdtemp(join(tmpdir(), 'auto-reimbursement-e2e-'));
const config: Config = {
  dataDir,
  dbPath: join(dataDir, 'app.sqlite'),
  host: '127.0.0.1',
  port: 3100,
  ai: null,
  concurrency: 4,
};
const store = openStore(config.dbPath);
const queue = createQueue({
  store,
  config,
  analyzer: new FakeAnalyzer(fixtureMap),
  onAnalyzed: (id, analysis) => applyAnalysis(store, id, analysis),
});
queue.start();
const server = createApp({ store, config, queue }).listen(config.port, config.host);

let closing: Promise<void> | null = null;
async function close(): Promise<void> {
  if (closing !== null) return closing;
  closing = (async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
    await queue.stop();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  })();
  return closing;
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => void close().then(() => process.exit(0), () => process.exit(1)));
}
}

void main();
