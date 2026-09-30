import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { hashAccessCode } from '../src/auth.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';

describe('rate limiting behind a reverse proxy', () => {
  const code = 'rate-limit-access-code';
  let temp: string;
  let store: Store;
  let config: Config;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-rate-'));
    store = openStore(join(temp, 'app.sqlite'));
    // 模拟 Railway：请求都经一层代理进来，真实客户端 IP 在 X-Forwarded-For
    config = loadConfig(
      { DATA_DIR: temp, ACCESS_CODE_SHA256: hashAccessCode(code), TRUST_PROXY: '1' },
      temp,
    );
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  it('does not let anonymous requests use up an authenticated user\'s upload quota', async () => {
    const application = createApp({ store, config });
    for (let index = 0; index < 40; index += 1) {
      const anonymous = await request(application)
        .post('/api/receipts/upload')
        .set('X-Forwarded-For', `203.0.113.${index}`);
      expect(anonymous.status).toBe(401);
    }
    const png = await sharp({
      create: { width: 16, height: 16, channels: 3, background: '#88aa66' },
    }).png().toBuffer();
    const upload = await request(application)
      .post('/api/receipts/upload')
      .set('X-Forwarded-For', '198.51.100.7')
      .set('Authorization', `Bearer ${code}`)
      .attach('files', png, 'receipt.png');
    expect(upload.status).toBe(201);
  });

  it('throttles access-code guessing per client IP without locking out other clients', async () => {
    const application = createApp({ store, config });
    const guess = () => request(application)
      .get('/api/ai/status')
      .set('X-Forwarded-For', '203.0.113.9')
      .set('Authorization', 'Bearer wrong-code');
    for (let index = 0; index < 30; index += 1) {
      expect((await guess()).status).toBe(401);
    }
    expect((await guess()).status).toBe(429);

    const owner = await request(application)
      .get('/api/ai/status')
      .set('X-Forwarded-For', '198.51.100.7')
      .set('Authorization', `Bearer ${code}`);
    expect(owner.status).toBe(200);
  });
});

describe('TRUST_PROXY config', () => {
  it('defaults to one proxy hop on Railway and none locally, and rejects invalid values', () => {
    const cwd = tmpdir();
    expect(loadConfig({}, cwd).trustProxy).toBe(0);
    expect(loadConfig({ RAILWAY_ENVIRONMENT_ID: 'env-1' }, cwd).trustProxy).toBe(1);
    expect(loadConfig({ RAILWAY_ENVIRONMENT_ID: 'env-1', TRUST_PROXY: '2' }, cwd).trustProxy).toBe(2);
    expect(loadConfig({ RAILWAY_ENVIRONMENT_ID: 'env-1', TRUST_PROXY: '0' }, cwd).trustProxy).toBe(0);
    expect(() => loadConfig({ TRUST_PROXY: 'yes' }, cwd)).toThrow('INVALID_TRUST_PROXY');
  });
});
