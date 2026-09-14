import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/db.js';

const netlifyOrigin = 'https://zidongbx.netlify.app';
const hostedConfig = loadConfig(
  { CORS_ORIGINS: netlifyOrigin },
  process.cwd(),
);
const store = openStore(':memory:');

afterAll(() => store.close());

describe('GET /health', () => {
  it('returns an ok status payload', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('rejects non-loopback mutation origins without blocking reads or the local UI proxy', async () => {
    const rejected = await request(app)
      .post('/health')
      .set('Origin', 'https://attacker.example');
    expect(rejected.status).toBe(403);
    expect(rejected.body).toEqual({
      code: 'CROSS_ORIGIN_MUTATION',
      message: '拒绝非本机来源的修改请求',
    });

    expect((await request(app)
      .post('/health')
      .set('Origin', 'http://127.0.0.1:5174')).status).toBe(404);
    expect((await request(app)
      .get('/health')
      .set('Origin', 'https://attacker.example')).status).toBe(200);
  });

  it('returns health without requiring an origin or AI configuration', async () => {
    const response = await request(createApp()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('allows the configured Netlify origin and answers preflight', async () => {
    const hostedApp = createApp({ store, config: hostedConfig });
    const preflight = await request(hostedApp)
      .options('/api/settings')
      .set('Origin', netlifyOrigin)
      .set('Access-Control-Request-Method', 'PUT')
      .set('Access-Control-Request-Headers', 'content-type');

    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe(
      netlifyOrigin,
    );
    expect(preflight.headers['access-control-allow-methods']).toContain('PUT');
    expect(preflight.headers['access-control-allow-headers']).toBe(
      'content-type',
    );
    expect(preflight.headers.vary).toContain('Origin');
  });

  it('exposes reads only to configured browser origins', async () => {
    const hostedApp = createApp({ store, config: hostedConfig });
    const allowed = await request(hostedApp)
      .get('/health')
      .set('Origin', netlifyOrigin);
    const rejected = await request(hostedApp)
      .get('/health')
      .set('Origin', 'https://attacker.example');

    expect(allowed.status).toBe(200);
    expect(allowed.headers['access-control-allow-origin']).toBe(netlifyOrigin);
    expect(rejected.status).toBe(200);
    expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects an unconfigured browser mutation', async () => {
    const response = await request(createApp({ store, config: hostedConfig }))
      .post('/api/backup')
      .set('Origin', 'https://attacker.example');

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      code: 'CROSS_ORIGIN_MUTATION',
      message: '拒绝非本机来源的修改请求',
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
