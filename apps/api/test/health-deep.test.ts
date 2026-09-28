import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { VOLUME_MARKER, volumeMarkerMissing } from '../src/volume.js';

// P-09：/health 深度检查（数据库 SELECT 1 + DATA_DIR 可写性）与卷标记自检
describe('deep health checks (P-09)', () => {
  let temp: string;
  let store: Store;
  let config: Config;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-health-'));
    store = openStore(':memory:');
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('returns ok when the database answers and DATA_DIR is writable', async () => {
    const response = await request(createApp({ store, config })).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
    store.close();
  });

  it('returns 503 when the database is unavailable', async () => {
    store.close(); // 关闭后 ping() 必抛错
    const response = await request(createApp({ store, config })).get('/health');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'error',
      checks: { database: 'fail', dataDir: 'ok' },
    });
  });

  it('returns 503 when DATA_DIR is not writable', async () => {
    // dataDir 指向一个普通文件（不是目录），写入探针必失败
    const filePath = join(temp, 'not-a-dir');
    await writeFile(filePath, 'x');
    const broken = loadConfig({ DATA_DIR: filePath }, temp);
    const response = await request(createApp({ store, config: broken })).get('/health');
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      status: 'error',
      checks: { database: 'ok', dataDir: 'fail' },
    });
    store.close();
  });
});

describe('volume marker self-check (P-09)', () => {
  let temp: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-volume-'));
  });

  afterEach(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  it('reports the marker missing until it is written', async () => {
    expect(volumeMarkerMissing(temp)).toBe(true);
    await writeFile(join(temp, VOLUME_MARKER), 'railway-volume');
    expect(volumeMarkerMissing(temp)).toBe(false);
  });
});
