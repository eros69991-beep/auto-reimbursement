import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

import {
  type FileIndexEntry,
  type FormOptions,
  type Note,
  type Settings,
} from '@auto-reimbursement/contracts';

import type { Config } from './config.js';
import type { Store } from './db.js';
import { safePath, storeSignatureImage, type InputImage } from './storage.js';

const AMOUNT_FLOOR = 0.8;
const CATEGORY_FLOOR = 0.7;
const SETTINGS_KEYS = [
  'id',
  'department',
  'dateMode',
  'customDate',
  'signerMode',
  'signerName',
  'signature',
  'amountThreshold',
  'categoryThreshold',
];

const DEFAULT_SETTINGS: Settings = {
  id: 'default',
  department: '',
  dateMode: 'today',
  customDate: null,
  signerMode: 'text',
  signerName: '',
  signature: null,
  amountThreshold: 0.95,
  categoryThreshold: 0.9,
};

export function getSettings(store: Store): Settings {
  return store.get('settings', 'default') ?? { ...DEFAULT_SETTINGS };
}

export function saveSettings(store: Store, input: Settings): Settings {
  const saved: Settings = {
    ...input,
    signature: canonicalSignature(store, input.signature),
  };
  validateSettings(store, saved);
  store.put('settings', saved);
  return saved;
}

export async function saveSignature(
  store: Store,
  config: Config,
  image: InputImage,
): Promise<Settings> {
  const signature = await storeSignatureImage(config, image);
  try {
    return store.transact(() => {
      const file: FileIndexEntry = {
        id: signature.id,
        ownerId: 'default',
        kind: 'signature',
        path: signature.path,
        sha256: signature.sha256,
        deletedAt: null,
      };
      const settings = getSettings(store);
      const saved: Settings = { ...settings, signature };
      store.put('files', file);
      store.put('settings', saved);
      return saved;
    });
  } catch (error) {
    try {
      await unlink(safePath(config.dataDir, signature.path));
    } catch {
      // Preserve the persistence error; this path belongs only to this upload.
    }
    throw error;
  }
}

export function saveNote(store: Store, note: Note): Note {
  validateNote(note);
  const saved: Note = { ...note };
  store.put('notes', saved);
  return saved;
}

export function deleteNote(store: Store, id: string): void {
  if (store.get('notes', id) === null) {
    throw new Error('NOTE_NOT_FOUND');
  }
  store.remove('notes', id);
}

export function createNote(store: Store, input: Omit<Note, 'id'>): Note {
  return saveNote(store, { id: randomUUID(), ...input });
}

export function resolveOptions(settings: Settings, now: Date): FormOptions {
  const today = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return {
    department: settings.department,
    date:
      settings.dateMode === 'blank'
        ? null
        : settings.dateMode === 'custom'
          ? settings.customDate
          : today,
    signerMode: settings.signerMode,
    signerName: settings.signerName,
    signature: settings.signerMode === 'image' ? settings.signature : null,
  };
}

function validateSettings(store: Store, value: Settings): void {
  if (
    value === null ||
    typeof value !== 'object' ||
    !hasExactKeys(value, SETTINGS_KEYS) ||
    value.id !== 'default' ||
    typeof value.department !== 'string' ||
    value.department.length > 100 ||
    (value.dateMode !== 'today' &&
      value.dateMode !== 'blank' &&
      value.dateMode !== 'custom') ||
    (value.customDate !== null && typeof value.customDate !== 'string') ||
    (value.signerMode !== 'text' && value.signerMode !== 'image') ||
    typeof value.signerName !== 'string' ||
    value.signerName.length > 100 ||
    !validThreshold(value.amountThreshold, AMOUNT_FLOOR) ||
    !validThreshold(value.categoryThreshold, CATEGORY_FLOOR)
  ) {
    throw new Error('INVALID_SETTINGS');
  }
  if (
    (value.dateMode === 'custom' &&
      (value.customDate === null || !isCalendarDate(value.customDate))) ||
    (value.customDate !== null && !isCalendarDate(value.customDate))
  ) {
    throw new Error('INVALID_DATE');
  }
  if (value.signerMode === 'image') {
    if (value.signature === null || !isIndexedSignature(store, value.signature)) {
      throw new Error('INVALID_SIGNATURE');
    }
  } else if (value.signature !== null && !isIndexedSignature(store, value.signature)) {
    throw new Error('INVALID_SIGNATURE');
  }
}

function validThreshold(value: unknown, floor: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= floor && value <= 1;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isIndexedSignature(store: Store, signature: unknown): boolean {
  if (!isImageReference(signature)) {
    return false;
  }
  const entry = store.get('files', signature.id);
  return (
    entry !== null &&
    entry.kind === 'signature' &&
    entry.ownerId === 'default' &&
    entry.deletedAt === signature.deletedAt &&
    entry.path === signature.path &&
    entry.sha256 === signature.sha256
  );
}

function canonicalSignature(
  store: Store,
  candidate: Settings['signature'],
): Settings['signature'] {
  if (candidate === null) {
    return null;
  }
  if (candidate === undefined || typeof candidate !== 'object') {
    throw new Error('INVALID_SIGNATURE');
  }
  const stored = getSettings(store).signature;
  if (
    stored === null ||
    candidate.id !== stored.id ||
    !isIndexedSignature(store, stored)
  ) {
    throw new Error('INVALID_SIGNATURE');
  }
  return { ...stored };
}

function isImageReference(value: unknown): value is NonNullable<Settings['signature']> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const reference = value as Record<string, unknown>;
  return (
    typeof reference.id === 'string' &&
    typeof reference.path === 'string' &&
    typeof reference.mime === 'string' &&
    typeof reference.sha256 === 'string' &&
    typeof reference.perceptualHash === 'string' &&
    typeof reference.bytes === 'number' &&
    Number.isSafeInteger(reference.bytes) &&
    typeof reference.width === 'number' &&
    Number.isSafeInteger(reference.width) &&
    typeof reference.height === 'number' &&
    Number.isSafeInteger(reference.height) &&
    (reference.deletedAt === null || typeof reference.deletedAt === 'string')
  );
}

function hasExactKeys(value: object, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function validateNote(note: Note): void {
  if (
    note === null ||
    typeof note !== 'object' ||
    typeof note.id !== 'string' ||
    note.id.length === 0 ||
    typeof note.name !== 'string' ||
    note.name.length === 0 ||
    note.name.length > 100 ||
    typeof note.content !== 'string' ||
    note.content.length > 2000
  ) {
    throw new Error('INVALID_NOTE');
  }
}
