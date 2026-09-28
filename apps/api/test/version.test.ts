import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';

// P-18：/api/version 返回 Railway 注入的 commit SHA，用于核对前后端版本一致
describe('GET /api/version (P-18)', () => {
  let temp: string;
  let store: Store;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-version-'));
    store = openStore(':memory:');
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('returns the injected commit SHA when present', async () => {
    const config = loadConfig(
      { DATA_DIR: temp, RAILWAY_GIT_COMMIT_SHA: '  519304eabc  ' },
      temp,
    );
    const response = await request(createApp({ store, config })).get('/api/version');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ commit: '519304eabc' });
  });

  it('returns null outside Railway', async () => {
    const config = loadConfig({ DATA_DIR: temp }, temp);
    const response = await request(createApp({ store, config })).get('/api/version');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ commit: null });
  });
});
