import { afterEach, describe, expect, it, vi } from 'vitest';

import { api, apiUrl, normalizeApiBaseUrl, requestJson } from './api';

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
    expect(api.imageUrl('image / 1')).toBe(
      'http://127.0.0.1:3000/api/images/image%20%2F%201',
    );
    expect(api.receiptOriginalUrl('receipt / 1')).toBe(
      'http://127.0.0.1:3000/api/receipts/receipt%20%2F%201/original-image',
    );
  });
});
