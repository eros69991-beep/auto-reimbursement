import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, apiUrl, fetchBlobUrl, normalizeApiBaseUrl, requestJson } from './api';

afterEach(() => vi.restoreAllMocks());

describe('hosted API URLs', () => {
  it('uses the local backend when the Vite value is missing or blank', () => {
    expect(normalizeApiBaseUrl(undefined)).toBe('http://127.0.0.1:3000');
    expect(normalizeApiBaseUrl('  ')).toBe('http://127.0.0.1:3000');
  });

  it('joins API and media paths without duplicate slashes', () => {
    expect(apiUrl('/api/health', 'https://api.example.railway.app/')).toBe(
      'https://api.example.railway.app/api/health',
    );
    expect(
      apiUrl('api/images/image-1', 'https://api.example.railway.app'),
    ).toBe('https://api.example.railway.app/api/images/image-1');
  });

  it('sends JSON requests to the selected API origin', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await requestJson(
      '/health',
      undefined,
      'https://api.example.railway.app',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.railway.app/health',
      undefined,
    );
  });

  it('returns absolute URLs for browser-loaded evidence', () => {
    const image = new URL(api.imageUrl('image / 1'));
    const receipt = new URL(api.receiptOriginalUrl('receipt / 1'));

    expect(image.pathname).toBe('/api/images/image%20%2F%201');
    expect(receipt.pathname).toBe(
      '/api/receipts/receipt%20%2F%201/original-image',
    );
    expect(image.origin).toMatch(/^https?:\/\//);
    expect(receipt.origin).toMatch(/^https?:\/\//);
  });
});

describe('authenticated file downloads', () => {
  it('reports the reason the server gives when it refuses the file', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'LAYOUT_OUTDATED', message: '请到「历史」页撤销本单，再重新生成。' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(fetchBlobUrl('/api/batches/b1/preview.pdf?attachments=1')).rejects.toMatchObject({
      message: '请到「历史」页撤销本单，再重新生成。',
      code: 'LAYOUT_OUTDATED',
    });
  });

  it('falls back to a generic message when the refusal has no readable reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad gateway', { status: 502 }));

    await expect(fetchBlobUrl('/api/batches/b1/pdf')).rejects.toThrow('加载失败');
  });
});
