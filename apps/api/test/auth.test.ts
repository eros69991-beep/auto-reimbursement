import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { hashAccessCode } from '../src/auth.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';

describe('access code auth', () => {
  let temp: string;
  let store: Store;
  let config: Config;
  const code = 'test-access-code';

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-auth-'));
    store = openStore(join(temp, 'app.sqlite'));
    config = loadConfig(
      { DATA_DIR: temp, ACCESS_CODE_SHA256: hashAccessCode(code) },
      temp,
    );
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('rejects /api requests without a code', async () => {
    const application = createApp({ store, config });
    const response = await request(application).get('/api/receipts?view=pool');
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('UNAUTHORIZED');
  });

  it('rejects /api requests with a wrong code', async () => {
    const application = createApp({ store, config });
    const response = await request(application)
      .get('/api/receipts?view=pool')
      .set('Authorization', 'Bearer wrong-code');
    expect(response.status).toBe(401);
  });

  it('accepts /api requests with the correct code', async () => {
    const application = createApp({ store, config });
    const response = await request(application)
      .get('/api/receipts?view=pool')
      .set('Authorization', `Bearer ${code}`);
    expect(response.status).toBe(200);
  });

  it('rejects mutations without a code even without an Origin header', async () => {
    const application = createApp({ store, config });
    const response = await request(application).post('/api/cleanup/2026-09');
    expect(response.status).toBe(401);
  });

  it('keeps /health open', async () => {
    const application = createApp({ store, config });
    const response = await request(application).get('/health');
    expect(response.status).toBe(200);
  });

  it('is disabled when ACCESS_CODE_SHA256 is not configured', async () => {
    const openConfig = loadConfig({ DATA_DIR: temp }, temp);
    const application = createApp({ store, config: openConfig });
    const response = await request(application).get('/api/receipts?view=pool');
    expect(response.status).toBe(200);
  });

  it('rejects an invalid ACCESS_CODE_SHA256 value at startup', () => {
    expect(() =>
      loadConfig({ DATA_DIR: temp, ACCESS_CODE_SHA256: 'not-a-hash' }, temp),
    ).toThrow('INVALID_ACCESS_CODE_SHA256');
  });

  it('sets security headers and hides x-powered-by', async () => {
    const application = createApp({ store, config });
    const response = await request(application)
      .get('/health');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
