import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseFen, type Analysis, type Category, type Reason } from '@auto-reimbursement/contracts';
import { createApp } from '../apps/api/src/app.ts';
import { AiError, type ReceiptAnalyzer } from '../apps/api/src/ai/types.ts';
import type { Config } from '../apps/api/src/config.ts';
import { openStore } from '../apps/api/src/db.ts';
import { applyAnalysis } from '../apps/api/src/decision.ts';
import { createQueue } from '../apps/api/src/queue.ts';

type Expected = {
  paidFen: number | null;
  category: Category | null;
  outcome: 'ready' | 'pending' | 'duplicate';
  reason: Reason | null;
};

export type Fixture = {
  id: string;
  file: string;
  run?: 'learning';
  expected: Expected;
  analysis: Analysis | null;
  failure: 'transient' | 'terminal' | null;
};

class FakeAnalyzer implements ReceiptAnalyzer {
  private readonly attempts = new Map<string, number>();

  constructor(private readonly fixtures: Map<string, Fixture>) {}

  callsFor(id: string): number {
    return this.attempts.get(id) ?? 0;
  }

  async analyzeReceipt(image: { bytes: Buffer }): Promise<Analysis> {
    const sha256 = createHash('sha256').update(image.bytes).digest('hex');
    const fixture = this.fixtures.get(sha256);
    if (fixture === undefined) throw new AiError('INVALID_RESPONSE', false);
    this.attempts.set(fixture.id, this.callsFor(fixture.id) + 1);
    if (fixture.failure === 'terminal') throw new AiError('AUTH', false);
    if (fixture.failure === 'transient' && this.callsFor(fixture.id) === 1) throw new AiError('UPSTREAM', true);
    if (fixture.analysis === null) throw new AiError('INVALID_RESPONSE', false);
    assertAnalysisMatchesFixture(fixture);
    return fixture.analysis;
  }
}

export type FixtureRuntime = {
  baseUrl: string;
  analyzer: FakeAnalyzer;
  close(): Promise<void>;
};

export async function createFixtureRuntime(port = 0): Promise<FixtureRuntime> {
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
    port,
    ai: null,
    concurrency: 4,
  };
  const store = openStore(config.dbPath);
  const analyzer = new FakeAnalyzer(fixtureMap);
  const queue = createQueue({
    store,
    config,
    analyzer,
    onAnalyzed: (id, analysis) => applyAnalysis(store, id, analysis),
  });
  queue.start();
  const server = createApp({ store, config, queue }).listen(config.port, config.host);
  await once(server, 'listening');
  const address = server.address() as AddressInfo;

  let closing: Promise<void> | null = null;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    analyzer,
    close(): Promise<void> {
      if (closing === null) {
        closing = (async () => {
          await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
          await queue.stop();
          store.close();
          await rm(dataDir, { recursive: true, force: true });
        })();
      }
      return closing;
    },
  };
}

function assertAnalysisMatchesFixture(fixture: Fixture): void {
  if (
    fixture.run === 'learning' ||
    fixture.analysis === null ||
    (fixture.expected.outcome === 'pending' && fixture.expected.reason === 'suspected_duplicate')
  ) return;
  const paidFen = fixture.analysis.amount === null ? null : parseFen(fixture.analysis.amount);
  if (paidFen !== fixture.expected.paidFen || fixture.analysis.category !== fixture.expected.category) {
    throw new AiError('INVALID_RESPONSE', false);
  }
}
