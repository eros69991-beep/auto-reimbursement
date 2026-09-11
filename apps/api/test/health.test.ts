import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { app } from '../src/app.js';

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
});
