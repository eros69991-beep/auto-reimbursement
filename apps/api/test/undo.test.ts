import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { createBatch } from '../src/batches.js';
import { getSettings, resolveOptions } from '../src/settings.js';
import { sampleReceipt } from './support.js';

const store = openStore(':memory:');
const app = createApp({ store, config: loadConfig({}, process.cwd()) });
afterEach(() => { for (const table of ['receipts', 'batches', 'files'] as const) for (const row of store.list(table)) store.remove(table, row.id); });

describe('recoverable receipt lifecycle', () => {
  it('removes and restores pool membership without deleting or losing amounts', async () => {
    store.put('receipts', sampleReceipt());
    expect((await request(app).post('/api/receipts/receipt-1/pool').send({ included: false })).status).toBe(200);
    expect((await request(app).get('/api/pool/totals')).body.totalFen).toBe(0);
    expect((await request(app).get('/api/receipts?view=excluded')).body).toHaveLength(1);
    expect((await request(app).post('/api/receipts/receipt-1/pool').send({ included: true })).status).toBe(200);
    expect((await request(app).get('/api/pool/totals')).body.totalFen).toBe(1000);
    expect(store.get('receipts', 'receipt-1')?.original.deletedAt).toBeNull();
  });
  it('soft-deletes in-flight uploads, stops progress counting, and restores them', async () => {
    store.put('receipts', sampleReceipt({ status: 'recognizing' }));
    expect((await request(app).delete('/api/receipts/receipt-1')).status).toBe(204);
    expect((await request(app).get('/api/progress?ids=receipt-1')).body).toMatchObject({ total: 0, recognizing: 0 });
    expect((await request(app).get('/api/receipts?view=deleted')).body).toHaveLength(1);
    expect((await request(app).post('/api/receipts/receipt-1/confirm')).status).toBe(409);
    const restored = await request(app).post('/api/receipts/receipt-1/restore');
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ deletedAt: null, status: 'recognizing' });
  });
  it('cancels an exported batch atomically, preserves its snapshot, and is idempotent after rebatching', async () => {
    store.put('receipts', sampleReceipt());
    const options = resolveOptions(getSettings(store), new Date());
    const batch = createBatch(store, ['receipt-1'], options, new Date());
    store.put('batches', { ...batch, pdfPath: 'saved.pdf' });
    expect((await request(app).post(`/api/batches/${batch.id}/cancel`)).status).toBe(200);
    expect(store.get('batches', batch.id)).toMatchObject({ items: batch.items, pdfPath: 'saved.pdf', cancelledAt: expect.any(String) });
    expect(store.get('receipts', 'receipt-1')).toMatchObject({ status: 'ready', batchId: null });
    expect((await request(app).get('/api/pool/totals')).body.totalFen).toBe(1000);
    const next = createBatch(store, ['receipt-1'], options, new Date());
    await request(app).post(`/api/batches/${batch.id}/cancel`);
    expect(store.get('receipts', 'receipt-1')?.batchId).toBe(next.id);
    expect((await request(app).post(`/api/batches/${batch.id}/export`)).status).toBe(409);
  });
  it('refuses cancellation when originals were permanently cleaned and changes nothing', async () => {
    store.put('receipts', sampleReceipt());
    const batch = createBatch(store, ['receipt-1'], resolveOptions(getSettings(store), new Date()), new Date());
    const current = store.get('receipts', 'receipt-1')!;
    store.put('receipts', { ...current, original: { ...current.original, deletedAt: new Date().toISOString() } });
    expect((await request(app).post(`/api/batches/${batch.id}/cancel`)).status).toBe(409);
    expect(store.get('receipts', 'receipt-1')?.batchId).toBe(batch.id);
    expect((await request(app).get('/api/pool/totals')).body.totalFen).toBe(0);
  });
});
