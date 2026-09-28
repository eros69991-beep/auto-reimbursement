import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';

// P-20：统一错误表、JSON 404、INVALID_JSON 兜底
describe('unified error handling', () => {
  let temp: string;
  let store: Store;
  let config: Config;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-errors-'));
    store = openStore(join(temp, 'app.sqlite'));
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('returns a JSON 404 for unknown /api routes', async () => {
    const application = createApp({ store, config });
    const response = await request(application).get('/api/no-such-route');
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ code: 'ROUTE_NOT_FOUND', message: '接口不存在' });
  });

  it('maps malformed JSON on batch options to 400 INVALID_JSON instead of 500', async () => {
    const application = createApp({ store, config });
    const response = await request(application)
      .patch('/api/batches/batch-1/options')
      .set('Content-Type', 'application/json')
      .send('{bad json');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_JSON');
  });

  it('maps malformed JSON on pool membership to 400 INVALID_JSON instead of 500', async () => {
    const application = createApp({ store, config });
    const response = await request(application)
      .post('/api/receipts/receipt-1/pool')
      .set('Content-Type', 'application/json')
      .send('{bad json');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_JSON');
  });

  it('keeps the path-specific code for malformed settings JSON', async () => {
    const application = createApp({ store, config });
    const response = await request(application)
      .put('/api/settings')
      .set('Content-Type', 'application/json')
      .send('{bad json');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_SETTINGS');
  });

  it('rejects an upload carrying an extra text field with a clear 400', async () => {
    const application = createApp({ store, config });
    const response = await request(application)
      .post('/api/receipts/upload')
      .field('unexpected', 'text')
      .attach('files', Buffer.from('fake'), 'receipt.jpg');
    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_UPLOAD');
  });
});
