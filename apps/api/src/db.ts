import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { types as utilTypes } from 'node:util';

import type { Category, Table, Tables } from '@auto-reimbursement/contracts';

const SCHEMA_VERSION = 2;
const MIGRATIONS = [
  readFileSync(join(__dirname, 'migrations', '001-initial.sql'), 'utf8'),
  readFileSync(join(__dirname, 'migrations', '002-corrections.sql'), 'utf8'),
];

const TABLE_NAMES = {
  receipts: 'receipts',
  rules: 'rules',
  settings: 'settings',
  notes: 'notes',
  batches: 'batches',
  files: 'files',
} as const satisfies Record<Table, string>;

export interface Store {
  get<K extends Table>(table: K, id: string): Tables[K] | null;
  list<K extends Table>(table: K): Tables[K][];
  put<K extends Table>(table: K, row: Tables[K]): void;
  remove(table: Table, id: string): void;
  transact<T>(fn: () => T): T;
  nextOrder(): number;
  recordConfirmation(receiptId: string, category: Category): boolean;
  backupTo(path: string): Promise<void>;
  close(): void;
}

function getTableName(table: Table): string {
  if (!Object.hasOwn(TABLE_NAMES, table)) {
    throw new Error('INVALID_TABLE');
  }
  return TABLE_NAMES[table];
}

function migrate(database: DatabaseSync): void {
  const versionRow = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };

  if (versionRow.user_version > SCHEMA_VERSION) {
    throw new Error('UNSUPPORTED_SCHEMA_VERSION');
  }
  if (versionRow.user_version === SCHEMA_VERSION) {
    return;
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    for (
      let version = versionRow.user_version;
      version < SCHEMA_VERSION;
      version += 1
    ) {
      database.exec(MIGRATIONS[version]!);
    }
    database.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

class SqliteStore implements Store {
  private transactionActive = false;

  constructor(private readonly database: DatabaseSync) {}

  get<K extends Table>(table: K, id: string): Tables[K] | null {
    const tableName = getTableName(table);
    const row = this.database
      .prepare(`SELECT data FROM ${tableName} WHERE id = ?`)
      .get(id) as { data: string } | undefined;
    return row === undefined ? null : (JSON.parse(row.data) as Tables[K]);
  }

  list<K extends Table>(table: K): Tables[K][] {
    const tableName = getTableName(table);
    const rows = this.database
      .prepare(`SELECT data FROM ${tableName}`)
      .all() as Array<{ data: string }>;
    return rows.map((row) => JSON.parse(row.data) as Tables[K]);
  }

  put<K extends Table>(table: K, row: Tables[K]): void {
    const tableName = getTableName(table);
    const data = JSON.stringify(row);
    this.database
      .prepare(
        `INSERT INTO ${tableName} (id, data) VALUES (?, ?)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(row.id, data);
  }

  remove(table: Table, id: string): void {
    const tableName = getTableName(table);
    this.database.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(id);
  }

  transact<T>(fn: () => T): T {
    if (this.transactionActive) {
      throw new Error('NESTED_TRANSACTION');
    }
    if (utilTypes.isAsyncFunction(fn)) {
      throw new Error('ASYNC_TRANSACTION');
    }

    this.database.exec('BEGIN IMMEDIATE');
    this.transactionActive = true;
    try {
      const result = fn();
      if (
        result !== null &&
        (typeof result === 'object' || typeof result === 'function') &&
        'then' in result
      ) {
        throw new Error('ASYNC_TRANSACTION');
      }
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.database.exec('ROLLBACK');
      } catch {
        // Preserve the callback or commit error if SQLite already ended the transaction.
      }
      throw error;
    } finally {
      this.transactionActive = false;
    }
  }

  nextOrder(): number {
    const row = this.database
      .prepare(
        `UPDATE counters SET value = value + 1
         WHERE name = 'upload_order'
         RETURNING value`,
      )
      .get() as { value: number } | undefined;
    if (row === undefined) {
      throw new Error('MISSING_UPLOAD_COUNTER');
    }
    return row.value;
  }

  recordConfirmation(receiptId: string, category: Category): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO corrections (receipt_id, category, data)
         VALUES (?, ?, ?)`,
      )
      .run(
        receiptId,
        category,
        JSON.stringify({
          receiptId,
          category,
          recordedAt: new Date().toISOString(),
        }),
      );
    return result.changes === 1;
  }

  async backupTo(path: string): Promise<void> {
    await backup(this.database, path);
  }

  close(): void {
    this.database.close();
  }
}

export function openStore(path: string): Store {
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
    migrate(database);
    return new SqliteStore(database);
  } catch (error) {
    database.close();
    throw error;
  }
}
