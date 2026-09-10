import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';

import type { Config } from './config.js';
import { openStore, type Store } from './db.js';
import { safePath } from './storage.js';

export async function backupAll(store: Store, config: Config): Promise<{ path: string; includesImages: false }> {
  const id = randomUUID();
  const tempDir = safePath(config.dataDir, `tmp/${id}`);
  const snapshotPath = join(tempDir, 'app.sqlite');
  const relativePath = `backups/${id}.zip`;
  const backupPath = safePath(config.dataDir, relativePath);
  await mkdir(tempDir, { recursive: true });
  await mkdir(safePath(config.dataDir, 'backups'), { recursive: true });
  await store.backupTo(snapshotPath);
  const snapshot = openStore(snapshotPath);
  try {
    const structured = {
      'settings.json': JSON.stringify(snapshot.list('settings')),
      'rules.json': JSON.stringify(snapshot.list('rules')),
      'files.json': JSON.stringify(snapshot.list('files')),
    };
    const bytes = new Uint8Array(await readFile(snapshotPath));
    const zip = zipSync({
      ...Object.fromEntries(Object.entries(structured).map(([name, text]) => [name, strToU8(text)])),
      'app.sqlite': bytes,
      'manifest.json': strToU8(JSON.stringify({ schemaVersion: 3, createdAt: new Date().toISOString(), includesImages: false })),
    });
    await writeFile(backupPath, zip, { flag: 'wx' });
    if (store.putBackup === undefined) throw new Error('BACKUP_INDEX_UNAVAILABLE');
    store.putBackup(id, relativePath);
    return { path: relativePath, includesImages: false };
  } finally {
    snapshot.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}
