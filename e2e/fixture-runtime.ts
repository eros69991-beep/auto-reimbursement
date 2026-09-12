import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseFen, type Analysis, type Category, type Reason } from '@auto-reimbursement/contracts';
import { createApp } from '../apps/api/src/app.ts';
import { AiError, type ReceiptAnalyzer } from '../apps/api/src/ai/types.ts';
import type { Config } from '../apps/api/src/config.ts';
import { openStore, type Store } from '../apps/api/src/db.ts';
import { applyAnalysis } from '../apps/api/src/decision.ts';
import { createQueue, type RecognitionQueue } from '../apps/api/src/queue.ts';

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
  dataDir: string;
  analyzer: FakeAnalyzer;
  restart(): Promise<void>;
  close(): Promise<void>;
};

type FixtureRuntimeOptions = {
  port?: number;
  startQueue?: boolean;
  ai?: Config['ai'];
};

export async function createFixtureRuntime(portOrOptions: number | FixtureRuntimeOptions = 0): Promise<FixtureRuntime> {
  const options = typeof portOrOptions === 'number' ? { port: portOrOptions } : portOrOptions;
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
    port: options.port ?? 0,
    ai: options.ai ?? null,
    concurrency: 4,
  };
  const analyzer = new FakeAnalyzer(fixtureMap);
  let store: Store | null = null;
  let queue: RecognitionQueue | null = null;
  let server: Server | null = null;
  let baseUrl = '';

  async function start(startQueue: boolean): Promise<void> {
    const nextStore = openStore(config.dbPath);
    const nextQueue = createQueue({
      store: nextStore,
      config,
      analyzer,
      onAnalyzed: (id, analysis) => applyAnalysis(nextStore, id, analysis),
    });
    if (startQueue) nextQueue.start();
    const nextServer = createApp({ store: nextStore, config, queue: nextQueue }).listen(config.port, config.host);
    await once(nextServer, 'listening');
    const address = nextServer.address() as AddressInfo;
    store = nextStore;
    queue = nextQueue;
    server = nextServer;
    baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async function stop(): Promise<void> {
    const currentServer = server;
    const currentQueue = queue;
    const currentStore = store;
    server = null;
    queue = null;
    store = null;
    if (currentServer !== null) {
      await new Promise<void>((resolve, reject) => currentServer.close((error) => error === undefined ? resolve() : reject(error)));
    }
    await currentQueue?.stop();
    currentStore?.close();
  }

  await start(options.startQueue ?? true);

  let closing: Promise<void> | null = null;
  return {
    get baseUrl(): string { return baseUrl; },
    dataDir,
    analyzer,
    async restart(): Promise<void> {
      await stop();
      await start(true);
    },
    close(): Promise<void> {
      if (closing === null) {
        closing = (async () => {
          await stop();
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
