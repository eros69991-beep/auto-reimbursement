import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  Note,
  Receipt,
  Rule,
  Settings,
  Status,
} from '@auto-reimbursement/contracts';
import { describe, expect, it } from 'vitest';

import { openStore } from '../src/db.js';
import { sampleReceipt } from './support.js';

const statuses: Status[] = [
  'recognizing',
  'pending',
  'ready',
  'generated',
  'archived',
];

function withTempDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'auto-reimbursement-db-'));
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('SQLite store', () => {
  it('rolls back a write and sequence allocation together', () => {
    const store = openStore(':memory:');
    try {
      expect(() =>
        store.transact(() => {
          store.put(
            'receipts',
            sampleReceipt({ uploadOrder: store.nextOrder() }),
          );
          throw new Error('abort');
        }),
      ).toThrow('abort');
      expect(store.list('receipts')).toEqual([]);
      expect(store.nextOrder()).toBe(1);
    } finally {
      store.close();
    }
  });

  it('rejects nested transactions and rolls back the outer transaction', () => {
    const store = openStore(':memory:');
    try {
      expect(() =>
        store.transact(() => {
          store.put('receipts', sampleReceipt());
          store.transact(() => undefined);
        }),
      ).toThrow('NESTED_TRANSACTION');
      expect(store.get('receipts', 'receipt-1')).toBeNull();
    } finally {
      store.close();
    }
  });

  it('does not invoke a declared async transaction callback', async () => {
    const store = openStore(':memory:');
    try {
      expect(() =>
        store.transact(async () => {
          await Promise.resolve();
          store.put(
            'receipts',
            sampleReceipt({ uploadOrder: store.nextOrder() }),
          );
        }),
      ).toThrow('ASYNC_TRANSACTION');
      await Promise.resolve();
      expect(store.list('receipts')).toEqual([]);
      expect(store.nextOrder()).toBe(1);
    } finally {
      store.close();
    }
  });

  it('rolls back when a non-async callback returns a promise', () => {
    const store = openStore(':memory:');
    try {
      expect(() =>
        store.transact(() => {
          store.put('receipts', sampleReceipt());
          return Promise.resolve();
        }),
      ).toThrow('ASYNC_TRANSACTION');
      expect(store.list('receipts')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('rejects a runtime-forged table name through the fixed whitelist', () => {
    const store = openStore(':memory:');
    try {
      const unsafeStore = store as unknown as {
        get(table: string, id: string): unknown;
      };
      expect(() =>
        unsafeStore.get('receipts; DROP TABLE receipts; --', 'receipt-1'),
      ).toThrow('INVALID_TABLE');
    } finally {
      store.close();
    }
  });

  it('round trips every receipt status and supports removal', () => {
    const store = openStore(':memory:');
    try {
      for (const [index, status] of statuses.entries()) {
        store.put(
          'receipts',
          sampleReceipt({ id: `receipt-${index}`, status }),
        );
      }

      expect(
        store
          .list('receipts')
          .map((receipt) => receipt.status)
          .sort(),
      ).toEqual([...statuses].sort());

      store.remove('receipts', 'receipt-2');
      expect(store.get('receipts', 'receipt-2')).toBeNull();
    } finally {
      store.close();
    }
  });

  it('persists typed rows and the upload sequence across a disk reopen', () => {
    withTempDirectory((directory) => {
      const databasePath = join(directory, 'reimbursements.sqlite');
      const receipt = sampleReceipt();
      const settings: Settings = {
        id: 'default',
        department: '行政部',
        dateMode: 'today',
        customDate: null,
        signerMode: 'text',
        signerName: '张三',
        signature: null,
        amountThreshold: 0.8,
        categoryThreshold: 0.7,
      };
      const rule: Rule = {
        id: 'rule-1',
        kind: 'merchant',
        key: '商店',
        originalCategory: null,
        category: '耗材',
        confirmations: 1,
        strong: false,
        updatedAt: '2026-09-03T00:00:00.000Z',
      };
      const note: Note = { id: 'note-1', name: '备注', content: '请审批' };

      const first = openStore(databasePath);
      try {
        first.put('receipts', receipt);
        first.put('settings', settings);
        first.put('rules', rule);
        first.put('notes', note);
        expect(first.nextOrder()).toBe(1);
      } finally {
        first.close();
      }

      const reopened = openStore(databasePath);
      try {
        expect(reopened.get('receipts', receipt.id)).toEqual(receipt);
        expect(reopened.get('settings', settings.id)).toEqual(settings);
        expect(reopened.get('rules', rule.id)).toEqual(rule);
        expect(reopened.get('notes', note.id)).toEqual(note);
        expect(reopened.nextOrder()).toBe(2);
      } finally {
        reopened.close();
      }
    });
  });

  it('creates a versioned schema that rejects invalid JSON', () => {
    withTempDirectory((directory) => {
      const databasePath = join(directory, 'reimbursements.sqlite');
      const store = openStore(databasePath);
      store.close();

      const database = new DatabaseSync(databasePath);
      try {
        expect(
          database.prepare('PRAGMA user_version').get(),
        ).toEqual({ user_version: 1 });
        expect(() =>
          database
            .prepare('INSERT INTO receipts (id, data) VALUES (?, ?)')
            .run('invalid-json', '{'),
        ).toThrow();
      } finally {
        database.close();
      }
    });
  });

  it('backs up an active WAL database through the SQLite backup API', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'auto-reimbursement-backup-'));
    const databasePath = join(directory, 'source.sqlite');
    const backupPath = join(directory, 'backup.sqlite');
    const store = openStore(databasePath);
    try {
      const receipt: Receipt = sampleReceipt({ id: 'receipt-in-backup' });
      store.put('receipts', receipt);
      await store.backupTo(backupPath);

      const backup = openStore(backupPath);
      try {
        expect(backup.get('receipts', receipt.id)).toEqual(receipt);
      } finally {
        backup.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
