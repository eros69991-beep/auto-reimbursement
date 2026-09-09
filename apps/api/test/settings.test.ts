import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Settings } from '@auto-reimbursement/contracts';
import sharp from 'sharp';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { openStore } from '../src/db.js';
import {
  getSettings,
  resolveOptions,
  saveNote,
  saveSettings,
  saveSignature,
} from '../src/settings.js';

it('keeps multiline notes and supports deliberately blank dates', () => {
  const store = openStore(':memory:');
  saveNote(store, { id: 'note-1', name: '采购', content: '第一行\n第二行' });
  const settings = saveSettings(store, {
    ...getSettings(store),
    dateMode: 'blank',
    department: '门店',
    signerMode: 'text',
    signerName: '张三',
  });

  expect(resolveOptions(settings, new Date('2026-09-03T12:00:00+08:00')))
    .toMatchObject({ department: '门店', date: null, signerName: '张三' });
  expect(store.get('notes', 'note-1')?.content).toBe('第一行\n第二行');
  store.close();
});

describe('reimbursement defaults and note library', () => {
  let temporaryDirectory: string;
  let config: Config;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'reimburse-settings-'));
    config = loadConfig(
      { DATA_DIR: temporaryDirectory, AI_BASE_URL: 'https://ai.invalid', AI_MODEL: 'model', AI_API_KEY: 'secret' },
      temporaryDirectory,
    );
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('uses validated persisted defaults, local dates, and only image-mode signatures', async () => {
    const store = openStore(':memory:');
    try {
      expect(getSettings(store)).toEqual({
        id: 'default',
        department: '',
        dateMode: 'today',
        customDate: null,
        signerMode: 'text',
        signerName: '',
        signature: null,
        amountThreshold: 0.95,
        categoryThreshold: 0.9,
      });
      expect(() =>
        saveSettings(store, { ...getSettings(store), dateMode: 'custom', customDate: '2026-02-29' }),
      ).toThrow('INVALID_DATE');
      expect(() =>
        saveSettings(store, { ...getSettings(store), signerMode: 'image', signature: fakeSignature() }),
      ).toThrow('INVALID_SIGNATURE');

      const saved = await saveSignature(store, config, {
        name: 'signature.png',
        mime: 'image/png',
        bytes: await png(),
      });
      const imageMode = saveSettings(store, { ...saved, signerMode: 'image' });
      expect(resolveOptions(imageMode, new Date(2026, 8, 3, 0, 1))).toMatchObject({
        date: '2026-09-03',
        signerMode: 'image',
        signature: saved.signature,
      });
      expect(resolveOptions({ ...imageMode, signerMode: 'text' }, new Date())).toMatchObject({
        signature: null,
      });
      expect(store.get('files', saved.signature!.id)).toMatchObject({
        kind: 'signature',
        ownerId: 'default',
        path: expect.stringMatching(/^settings\/signatures\//),
      });
    } finally {
      store.close();
    }
  });

  it('validates notes and preserves settings and multiline notes after reopening', () => {
    const databasePath = join(temporaryDirectory, 'settings.sqlite');
    const first = openStore(databasePath);
    saveSettings(first, { ...getSettings(first), department: '门店', dateMode: 'custom', customDate: '2028-02-29' });
    saveNote(first, { id: 'durable', name: '采购', content: '第一行\n第二行' });
    expect(() => saveNote(first, { id: 'empty', name: '', content: '' })).toThrow('INVALID_NOTE');
    first.close();

    const reopened = openStore(databasePath);
    try {
      expect(getSettings(reopened)).toMatchObject({ department: '门店', customDate: '2028-02-29' });
      expect(reopened.get('notes', 'durable')).toEqual({
        id: 'durable', name: '采购', content: '第一行\n第二行',
      });
    } finally {
      reopened.close();
    }
  });

  it('provides settings, generated note IDs, matching updates, and no config secrets over HTTP', async () => {
    const store = openStore(':memory:');
    try {
      const app = createApp({ store, config });
      const settings = await request(app).get('/api/settings');
      expect(settings.status).toBe(200);
      expect(JSON.stringify(settings.body)).not.toContain('secret');

      const created = await request(app).post('/api/notes').send({ id: 'ignored', name: '采购', content: '第一行\n第二行' });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ name: '采购', content: '第一行\n第二行' });
      expect(created.body.id).not.toBe('ignored');

      const mismatch = await request(app).put(`/api/notes/${created.body.id}`).send({ ...created.body, id: 'other' });
      expect(mismatch.status).toBe(400);
      expect(mismatch.body.code).toBe('INVALID_NOTE_ID');
      expect((await request(app).delete(`/api/notes/${created.body.id}`)).status).toBe(204);
      expect((await request(app).delete(`/api/notes/${created.body.id}`)).status).toBe(404);
    } finally {
      store.close();
    }
  });

  it('removes a newly written signature if settings persistence fails', async () => {
    const store = openStore(':memory:');
    store.close();
    await expect(saveSignature(store, config, { name: 'signature.png', mime: 'image/png', bytes: await png() })).rejects.toThrow();
    expect(await filesUnder(temporaryDirectory)).toEqual([]);
  });
});

function fakeSignature(): NonNullable<Settings['signature']> {
  return {
    id: 'forged', path: 'settings/signatures/forged.png', mime: 'image/png',
    sha256: '0'.repeat(64), perceptualHash: '0000000000000000', bytes: 1,
    width: 1, height: 1, deletedAt: null,
  };
}

async function png(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: '#135724' } })
    .png()
    .toBuffer();
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}
