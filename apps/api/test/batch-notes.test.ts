import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Batch, Note } from '@auto-reimbursement/contracts';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore, type Store } from '../src/db.js';
import { createNote } from '../src/settings.js';
import { sampleReceipt } from './support.js';

// Task 03：批次内备注 —— 多行保存、清空、刷新恢复、A/B 批次与全局模板隔离、定稿锁定。
describe('batch-scoped notes', () => {
  let store: Store;
  let temp: string;
  let config: Config;
  let dbFile: string;

  beforeEach(async () => {
    temp = await mkdtemp(join(tmpdir(), 'auto-reimbursement-batch-notes-'));
    dbFile = join(temp, 'store.sqlite');
    store = openStore(dbFile);
    config = loadConfig({ DATA_DIR: temp }, temp);
  });

  afterEach(async () => {
    store.close();
    await rm(temp, { recursive: true, force: true });
  });

  async function createBatchWithNote(): Promise<{ batch: Batch; template: Note }> {
    const template = createNote(store, { name: '通用模板', content: '模板内容' });
    store.put('receipts', sampleReceipt({ id: 'r1' }));
    const application = createApp({ store, config });
    const created = await request(application)
      .post('/api/batches')
      .send({
        receiptIds: ['r1'],
        options: {
          department: 'D',
          date: '2026-09-26',
          signerMode: 'text',
          signerName: 'S',
          signature: null,
        },
      });
    expect(created.status).toBe(201);
    return { batch: created.body as Batch, template };
  }

  it('creates a multi-line note inside the batch and attaches it to a sheet', async () => {
    const { batch } = await createBatchWithNote();
    const application = createApp({ store, config });
    const content = '第一行：交通费\n第二行，含标点！\n第三行  English & <b>纯文本</b>';

    const created = await request(application)
      .post(`/api/batches/${batch.id}/notes`)
      .send({ name: '第 1 页备注', content });
    expect(created.status).toBe(201);
    const withNote = created.body as Batch;
    const note = withNote.notes.find((item) => item.name === '第 1 页备注');
    expect(note).toBeDefined();
    expect(note!.content).toBe(content);

    const noteBySheet = Object.fromEntries(withNote.sheets.map((sheet) => [sheet.id, sheet.noteId]));
    noteBySheet[withNote.sheets[0]!.id] = note!.id;
    const attached = await request(application)
      .patch(`/api/batches/${batch.id}/options`)
      .send({ options: withNote.options, noteBySheet });
    expect(attached.status).toBe(200);
    expect((attached.body as Batch).sheets[0]!.noteId).toBe(note!.id);

    // 刷新/重开后仍在
    store.close();
    store = openStore(dbFile);
    const reopened = createApp({ store, config });
    const refetched = await request(reopened).get(`/api/batches/${batch.id}`);
    const refetchedNote = (refetched.body as Batch).notes.find((item) => item.id === note!.id);
    expect(refetchedNote?.content).toBe(content);
    expect((refetched.body as Batch).sheets[0]!.noteId).toBe(note!.id);
  });

  it('updates note content in place and clears a sheet note via empty detach', async () => {
    const { batch } = await createBatchWithNote();
    const application = createApp({ store, config });
    const sheetId = batch.sheets[0]!.id;
    const templateId = batch.notes.find((note) => note.name === '通用模板')!.id;

    // 先挂上模板，再就地改内容（批次快照内，不影响全局模板）
    const noteBySheet = { [sheetId]: templateId };
    await request(application)
      .patch(`/api/batches/${batch.id}/options`)
      .send({ options: batch.options, noteBySheet });

    const updated = await request(application)
      .put(`/api/batches/${batch.id}/notes/${templateId}`)
      .send({ content: '改后的\n多行内容' });
    expect(updated.status).toBe(200);
    expect(
      (updated.body as Batch).notes.find((note) => note.id === templateId)?.content,
    ).toBe('改后的\n多行内容');
    // 全局模板不受影响
    expect(store.get('notes', templateId)?.content).toBe('模板内容');

    // 清空 = noteBySheet 置 null
    const cleared = await request(application)
      .patch(`/api/batches/${batch.id}/options`)
      .send({ options: batch.options, noteBySheet: { [sheetId]: null } });
    expect(cleared.status).toBe(200);
    expect((cleared.body as Batch).sheets[0]!.noteId).toBeNull();
  });

  it('keeps A/B batches isolated when editing the same template snapshot', async () => {
    const { batch: batchA, template } = await createBatchWithNote();
    store.put('receipts', sampleReceipt({ id: 'r2', uploadOrder: 2 }));
    const application = createApp({ store, config });
    const createdB = await request(application)
      .post('/api/batches')
      .send({
        receiptIds: ['r2'],
        options: {
          department: 'D',
          date: '2026-09-26',
          signerMode: 'text',
          signerName: 'S',
          signature: null,
        },
      });
    const batchB = createdB.body as Batch;

    const updated = await request(application)
      .put(`/api/batches/${batchA.id}/notes/${template.id}`)
      .send({ content: '只属于 A 的内容' });
    expect(updated.status).toBe(200);

    const fetchedB = await request(application).get(`/api/batches/${batchB.id}`);
    expect(
      (fetchedB.body as Batch).notes.find((note) => note.id === template.id)?.content,
    ).toBe('模板内容');
    expect(store.get('notes', template.id)?.content).toBe('模板内容');
  });

  it('rejects invalid input and locks notes after export', async () => {
    const { batch } = await createBatchWithNote();
    const application = createApp({ store, config });

    const tooLong = await request(application)
      .post(`/api/batches/${batch.id}/notes`)
      .send({ name: 'x', content: '长'.repeat(2001) });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.code).toBe('INVALID_NOTE');

    const emptyName = await request(application)
      .post(`/api/batches/${batch.id}/notes`)
      .send({ name: '', content: 'x' });
    expect(emptyName.status).toBe(400);

    const missing = await request(application)
      .put(`/api/batches/${batch.id}/notes/no-such-note`)
      .send({ content: 'x' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOTE_NOT_FOUND');

    // 直接置为已定稿（导出需要真实附件图片，锁定行为与导出途径无关）
    store.put('batches', { ...batch, pdfPath: '2026-09/exports/final.pdf' });
    const locked = await request(application)
      .post(`/api/batches/${batch.id}/notes`)
      .send({ name: 'x', content: 'x' });
    expect(locked.status).toBe(409);
    expect(locked.body.code).toBe('BATCH_FINALIZED');
    const lockedUpdate = await request(application)
      .put(`/api/batches/${batch.id}/notes/${batch.notes[0]!.id}`)
      .send({ content: 'x' });
    expect(lockedUpdate.status).toBe(409);
  });
});
