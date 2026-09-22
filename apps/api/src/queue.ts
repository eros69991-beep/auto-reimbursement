import { readFile } from 'node:fs/promises';

import {
  parseFen,
  type Analysis,
  type Progress,
  type Receipt,
} from '@auto-reimbursement/contracts';

import { AiError, type ReceiptAnalyzer } from './ai/types.js';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { safePath } from './storage.js';

const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1_000, 3_000] as const;

export type RecognitionQueue = {
  start(): void;
  enqueue(ids: string[]): void;
  drain(): Promise<void>;
  stop(): Promise<void>;
};

type QueueDependencies = {
  store: Store;
  config: Config;
  analyzer: ReceiptAnalyzer;
  onAnalyzed: (id: string, result: Analysis) => void;
  now?: () => Date;
};

export function createQueue({
  store,
  config,
  analyzer,
  onAnalyzed,
  now = () => new Date(),
}: QueueDependencies): RecognitionQueue {
  const inFlight = new Map<string, Promise<void>>();
  const drainWaiters = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let stopping = false;
  let stopPromise: Promise<void> | null = null;

  function clearWakeTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function orderedRecognizing(): Receipt[] {
    return store
      .list('receipts')
      .filter(
        (receipt) =>
          receipt.status === 'recognizing' && receipt.deletedAt === null,
      )
      .sort((left, right) => {
        const order = left.uploadOrder - right.uploadOrder;
        return order !== 0
          ? order
          : left.id < right.id
            ? -1
            : left.id > right.id
              ? 1
              : 0;
      });
  }

  function failExhausted(): void {
    for (const receipt of orderedRecognizing()) {
      if (receipt.attempts < MAX_ATTEMPTS || inFlight.has(receipt.id)) {
        continue;
      }
      store.transact(() => {
        const current = store.get('receipts', receipt.id);
        if (
          current === null ||
          current.status !== 'recognizing' ||
          current.deletedAt !== null ||
          current.attempts < MAX_ATTEMPTS
        ) {
          return;
        }
        store.put('receipts', {
          ...current,
          status: 'pending',
          pendingReasons: appendReason(current.pendingReasons, 'api_failed'),
          nextAttemptAt: null,
        });
      });
    }
  }

  function hasScheduledWork(): boolean {
    return orderedRecognizing().length > 0;
  }

  function settleDrainsIfIdle(): void {
    if (inFlight.size !== 0 || (!stopping && hasScheduledWork())) {
      return;
    }
    for (const resolve of drainWaiters) {
      resolve();
    }
    drainWaiters.clear();
  }

  function scheduleWake(): void {
    if (!started || stopping || timer !== null) {
      return;
    }
    const nowMs = now().getTime();
    const nextDue = orderedRecognizing()
      .filter(
        (receipt) =>
          !inFlight.has(receipt.id) &&
          receipt.attempts < MAX_ATTEMPTS &&
          receipt.nextAttemptAt !== null &&
          Date.parse(receipt.nextAttemptAt) > nowMs,
      )
      .reduce<number | null>((earliest, receipt) => {
        const due = Date.parse(receipt.nextAttemptAt!);
        return earliest === null || due < earliest ? due : earliest;
      }, null);
    if (nextDue === null) {
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, Math.max(0, nextDue - nowMs));
  }

  function pump(): void {
    if (!started || stopping) {
      settleDrainsIfIdle();
      return;
    }
    clearWakeTimer();
    failExhausted();
    const nowIso = now().toISOString();
    const available = config.concurrency - inFlight.size;
    const candidates = orderedRecognizing()
      .filter(
        (receipt) =>
          !inFlight.has(receipt.id) &&
          receipt.attempts < MAX_ATTEMPTS &&
          (receipt.nextAttemptAt === null || receipt.nextAttemptAt <= nowIso),
      )
      .slice(0, Math.max(0, available));

    for (const receipt of candidates) {
      const id = receipt.id;
      // Reserve every slot synchronously before any asynchronous read begins.
      inFlight.set(id, Promise.resolve());
      const work = processOne(id).finally(() => {
        inFlight.delete(id);
        pump();
        settleDrainsIfIdle();
      });
      inFlight.set(id, work);
    }
    scheduleWake();
    settleDrainsIfIdle();
  }

  async function processOne(id: string): Promise<void> {
    const claimed = store.transact(() => {
      const receipt = store.get('receipts', id);
      if (
        receipt === null ||
        receipt.status !== 'recognizing' ||
        receipt.deletedAt !== null ||
        receipt.attempts >= MAX_ATTEMPTS
      ) {
        return null;
      }
      const updated: Receipt = {
        ...receipt,
        attempts: receipt.attempts + 1,
        nextAttemptAt: null,
      };
      store.put('receipts', updated);
      return updated;
    });
    if (claimed === null) {
      return;
    }

    try {
      const entry = store.get('files', claimed.original.id);
      if (
        entry === null ||
        entry.ownerId !== claimed.id ||
        entry.kind !== 'original' ||
        entry.path !== claimed.original.path ||
        entry.deletedAt !== null
      ) {
        throw new Error('ORIGINAL_UNAVAILABLE');
      }
      const bytes = await readFile(safePath(config.dataDir, entry.path));
      const result = await analyzer.analyzeReceipt({
        bytes,
        mime: claimed.original.mime,
      });
      onAnalyzed(id, result);
    } catch (error) {
      recordFailure(id, error);
    }
  }

  function recordFailure(id: string, error: unknown): void {
    store.transact(() => {
      const receipt = store.get('receipts', id);
      if (
        receipt === null ||
        receipt.status !== 'recognizing' ||
        receipt.deletedAt !== null
      ) {
        return;
      }
      const retryable = error instanceof AiError && error.retryable;
      if (retryable && receipt.attempts < MAX_ATTEMPTS) {
        const delay = RETRY_DELAYS_MS[receipt.attempts - 1];
        store.put('receipts', {
          ...receipt,
          nextAttemptAt: new Date(now().getTime() + delay).toISOString(),
        });
        return;
      }
      store.put('receipts', {
        ...receipt,
        status: 'pending',
        pendingReasons: appendReason(receipt.pendingReasons, 'api_failed'),
        nextAttemptAt: null,
      });
    });
  }

  return {
    start(): void {
      if (started) {
        return;
      }
      started = true;
      pump();
    },

    enqueue(ids: string[]): void {
      if (ids.length > 0) {
        pump();
      }
    },

    drain(): Promise<void> {
      if (inFlight.size === 0 && (stopping || !hasScheduledWork())) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        drainWaiters.add(resolve);
        pump();
      });
    },

    stop(): Promise<void> {
      if (stopPromise !== null) {
        return stopPromise;
      }
      stopping = true;
      clearWakeTimer();
      stopPromise = Promise.allSettled([...inFlight.values()]).then(() => {
        settleDrainsIfIdle();
      });
      return stopPromise;
    },
  };
}

export function persistAnalysis(
  store: Store,
  id: string,
  analysis: Analysis,
): Receipt {
  return store.transact(() => {
    const receipt = store.get('receipts', id);
    if (receipt === null) {
      throw new Error('RECEIPT_NOT_FOUND');
    }
    if (receipt.status !== 'recognizing' || receipt.deletedAt !== null) {
      throw new Error('INVALID_RECEIPT_STATE');
    }
    const updated: Receipt = {
      ...receipt,
      analysis,
      recognizedFen: analysis.amount === null ? null : parseFen(analysis.amount),
      status: 'pending',
      pendingReasons: ['amount_uncertain', 'category_uncertain'],
      nextAttemptAt: null,
    };
    store.put('receipts', updated);
    return updated;
  });
}

export function getProgress(store: Store, ids: string[]): Progress {
  const requested = new Set(ids.filter((id) => id.length > 0));
  const receipts = store
    .list('receipts')
    .filter((receipt) => requested.has(receipt.id) && receipt.deletedAt === null);
  return {
    recognizing: receipts.filter((receipt) => receipt.status === 'recognizing')
      .length,
    ready: receipts.filter((receipt) => receipt.status === 'ready').length,
    pending: receipts.filter((receipt) => receipt.status === 'pending').length,
    total: receipts.length,
  };
}

function appendReason(
  reasons: Receipt['pendingReasons'],
  reason: Receipt['pendingReasons'][number],
): Receipt['pendingReasons'] {
  return reasons.includes(reason) ? reasons : [...reasons, reason];
}
