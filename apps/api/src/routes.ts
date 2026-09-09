import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { Router } from 'express';
import multer from 'multer';
import {
  CATEGORIES,
  type Category,
  type FormOptions,
  type Note,
  type Rule,
  type Settings,
} from '@auto-reimbursement/contracts';

import { getApiStatus } from './ai/openai-compatible.js';
import {
  createBatch,
  getBatch,
  moveBatchGroup,
  poolTotals,
  updateBatchOptions,
} from './batches.js';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { confirmDistinct } from './duplicates.js';
import { deleteRule, listRules, saveRule } from './learning.js';
import { getProgress, type RecognitionQueue } from './queue.js';
import {
  confirmReceipt,
  deleteReceipt,
  listReceipts,
  updateReceipt,
  uploadReceipts,
} from './receipts.js';
import { addRefundImage, setRefund } from './refunds.js';
import {
  createNote,
  deleteNote,
  getSettings,
  saveNote,
  saveSettings,
  saveSignature,
} from './settings.js';
import { safePath } from './storage.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fields: 0, files: 50, fileSize: MAX_IMAGE_BYTES },
});
const refundUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fields: 0, files: 1, fileSize: MAX_IMAGE_BYTES },
});
const signatureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fields: 0, fileSize: MAX_IMAGE_BYTES },
});

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function createRouter(
  store: Store,
  config: Config,
  queue?: RecognitionQueue,
): Router {
  const router = Router();

  router.get('/ai/status', (_request, response) => {
    response.json(getApiStatus(config));
  });

  router.get('/settings', (_request, response) => {
    response.json(getSettings(store));
  });

  router.put('/settings', (request, response, next) => {
    try {
      response.json(saveSettings(store, settingsFromRequest(request.body)));
    } catch (error) {
      next(settingsHttpError(error));
    }
  });

  router.post(
    '/settings/signature',
    signatureUpload.single('file'),
    async (request, response, next) => {
      try {
        if (request.file === undefined) {
          throw new HttpError(400, 'EMPTY_SIGNATURE', '请选择签名图片');
        }
        response.json(
          await saveSignature(store, config, {
            name: request.file.originalname,
            mime: request.file.mimetype,
            bytes: request.file.buffer,
          }),
        );
      } catch (error) {
        next(settingsHttpError(error));
      }
    },
  );

  router.get('/notes', (_request, response) => {
    response.json(store.list('notes'));
  });

  router.get('/notes/:id', (request, response, next) => {
    const note = store.get('notes', request.params.id);
    if (note === null) {
      next(new HttpError(404, 'NOTE_NOT_FOUND', '备注不存在'));
      return;
    }
    response.json(note);
  });

  router.post('/notes', (request, response, next) => {
    try {
      response.status(201).json(createNote(store, noteForCreate(request.body)));
    } catch (error) {
      next(settingsHttpError(error));
    }
  });

  router.put('/notes/:id', (request, response, next) => {
    try {
      response.json(saveNote(store, noteForUpdate(request.params.id, request.body)));
    } catch (error) {
      next(settingsHttpError(error));
    }
  });

  router.delete('/notes/:id', (request, response, next) => {
    try {
      deleteNote(store, request.params.id);
      response.status(204).end();
    } catch (error) {
      next(settingsHttpError(error));
    }
  });

  router.get('/progress', (request, response) => {
    const ids =
      typeof request.query.ids === 'string'
        ? request.query.ids
            .split(',')
            .map((id) => id.trim())
            .filter(Boolean)
        : [];
    response.json(getProgress(store, ids));
  });

  router.get('/receipts', (request, response, next) => {
    if (request.query.view !== 'pool' && request.query.view !== 'pending') {
      next(new HttpError(400, 'INVALID_RECEIPT_VIEW', '请求参数无效'));
      return;
    }
    response.json(listReceipts(store, request.query.view));
  });

  router.get('/pool/totals', (_request, response) => {
    response.json(poolTotals(store.list('receipts')));
  });

  router.delete('/receipts/:id', (request, response, next) => {
    try {
      deleteReceipt(store, request.params.id, new Date());
      response.status(204).end();
    } catch (error) {
      next(correctionHttpError(error));
    }
  });

  router.post('/batches', (request, response, next) => {
    try {
      const { receiptIds, options } = batchRequest(request.body);
      response.status(201).json(createBatch(store, receiptIds, options, new Date()));
    } catch (error) {
      next(batchHttpError(error));
    }
  });

  router.get('/batches/:id', (request, response, next) => {
    try {
      response.json(getBatch(store, request.params.id));
    } catch (error) {
      next(batchHttpError(error));
    }
  });

  router.post('/batches/:id/move', (request, response, next) => {
    try {
      const { category, direction } = batchMoveRequest(request.body);
      response.json(moveBatchGroup(store, request.params.id, category, direction));
    } catch (error) {
      next(batchHttpError(error));
    }
  });

  router.patch('/batches/:id/options', (request, response, next) => {
    try {
      const { options, noteBySheet } = batchOptionsRequest(request.body);
      response.json(updateBatchOptions(store, request.params.id, options, noteBySheet));
    } catch (error) {
      next(batchHttpError(error));
    }
  });

  // Multer keeps each image in memory. A 50-file maximum-size upload can
  // therefore require substantial local RAM, bounded to 50 x 20 MiB.
  router.post(
    '/receipts/upload',
    upload.array('files', 50),
    async (request, response, next) => {
      try {
        const files = (request.files as Express.Multer.File[] | undefined) ?? [];
        if (files.length === 0) {
          response.status(400).json({
            code: 'EMPTY_UPLOAD',
            message: '请选择凭证图片',
          });
          return;
        }
        const result = await uploadReceipts(
          store,
          config,
          files.map((file) => ({
            name: file.originalname,
            mime: file.mimetype,
            bytes: file.buffer,
          })),
          new Date(),
        );
        queue?.enqueue(result.accepted.map((receipt) => receipt.id));
        response.status(201).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/images/:id', async (request, response, next) => {
    try {
      const entry = store.get('files', request.params.id);
      if (entry === null || entry.kind === 'pdf') {
        throw new HttpError(404, 'IMAGE_NOT_FOUND', '图片不存在');
      }
      if (entry.deletedAt !== null) {
        throw new HttpError(410, 'IMAGE_DELETED', '图片已删除');
      }

      let bytes: Buffer;
      try {
        bytes = await readFile(safePath(config.dataDir, entry.path));
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          throw new HttpError(404, 'IMAGE_NOT_FOUND', '图片不存在');
        }
        throw error;
      }
      response.type(extname(entry.path)).send(bytes);
    } catch (error) {
      next(error);
    }
  });

  router.post('/receipts/:id/confirm-distinct', (request, response, next) => {
    try {
      const receipt = confirmDistinct(store, request.params.id);
      if (receipt.status === 'recognizing') {
        queue?.enqueue([receipt.id]);
      }
      response.json(receipt);
    } catch (error) {
      if (error instanceof Error && error.message === 'RECEIPT_NOT_FOUND') {
        next(new HttpError(404, 'RECEIPT_NOT_FOUND', '凭证不存在'));
        return;
      }
      if (error instanceof Error && error.message === 'IMMUTABLE_RECEIPT') {
        next(
          new HttpError(409, 'IMMUTABLE_RECEIPT', '已归档凭证不可修改'),
        );
        return;
      }
      next(error);
    }
  });

  router.patch('/receipts/:id', (request, response, next) => {
    try {
      const receipt = updateReceipt(
        store,
        request.params.id,
        receiptPatchFromRequest(request.body),
      );
      response.json(receipt);
    } catch (error) {
      next(correctionHttpError(error));
    }
  });

  router.post('/receipts/:id/confirm', (request, response, next) => {
    try {
      response.json(confirmReceipt(store, request.params.id));
    } catch (error) {
      next(correctionHttpError(error));
    }
  });

  router.put('/receipts/:id/refund', (request, response, next) => {
    try {
      response.json(
        setRefund(
          store,
          request.params.id,
          refundFenFromRequest(request.body),
        ),
      );
    } catch (error) {
      next(correctionHttpError(error));
    }
  });

  router.post(
    '/receipts/:id/refund-images',
    refundUpload.single('file'),
    async (request, response, next) => {
      try {
        const id = request.params.id;
        if (typeof id !== 'string') {
          throw new HttpError(404, 'RECEIPT_NOT_FOUND', '凭证不存在');
        }
        if (request.file === undefined) {
          throw new HttpError(400, 'EMPTY_REFUND_IMAGE', '请选择退款凭证图片');
        }
        response.json(
          await addRefundImage(store, config, id, {
            name: request.file.originalname,
            mime: request.file.mimetype,
            bytes: request.file.buffer,
          }),
        );
      } catch (error) {
        next(correctionHttpError(error));
      }
    },
  );

  router.get('/rules', (_request, response) => {
    response.json(listRules(store));
  });

  router.put('/rules/:id', (request, response, next) => {
    try {
      response.json(
        saveRule(store, ruleFromRequest(request.params.id, request.body)),
      );
    } catch (error) {
      next(correctionHttpError(error));
    }
  });

  router.delete('/rules/:id', (request, response) => {
    deleteRule(store, request.params.id);
    response.status(204).end();
  });

  router.post('/receipts/:id/retry', (request, response, next) => {
    try {
      const receipt = store.transact(() => {
        const current = store.get('receipts', request.params.id);
        if (current === null) {
          throw new HttpError(404, 'RECEIPT_NOT_FOUND', '凭证不存在');
        }
        if (
          current.status !== 'pending' ||
          !current.pendingReasons.includes('api_failed')
        ) {
          throw new HttpError(409, 'RETRY_NOT_ALLOWED', '该凭证不可重试');
        }
        const updated = {
          ...current,
          status: 'recognizing' as const,
          pendingReasons: current.pendingReasons.filter(
            (reason) => reason !== 'api_failed',
          ),
          attempts: 0,
          nextAttemptAt: null,
        };
        store.put('receipts', updated);
        return updated;
      });
      queue?.enqueue([receipt.id]);
      response.json(receipt);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function ruleFromRequest(id: string, body: unknown): Rule {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('INVALID_RULE');
  }
  const value = body as Record<string, unknown>;
  if (
    (value.kind !== 'merchant' && value.kind !== 'keyword') ||
    typeof value.key !== 'string' ||
    typeof value.category !== 'string' ||
    (value.originalCategory !== null &&
      typeof value.originalCategory !== 'string') ||
    typeof value.confirmations !== 'number' ||
    typeof value.strong !== 'boolean'
  ) {
    throw new Error('INVALID_RULE');
  }
  return {
    id,
    kind: value.kind,
    key: value.key,
    originalCategory: value.originalCategory as Rule['originalCategory'],
    category: value.category as Rule['category'],
    confirmations: value.confirmations,
    strong: value.strong,
    updatedAt: new Date().toISOString(),
  };
}

function receiptPatchFromRequest(body: unknown): {
  paidFen?: number;
  category?: Rule['category'];
} {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('INVALID_RECEIPT_PATCH');
  }
  const value = body as Record<string, unknown>;
  if (!Object.hasOwn(value, 'paidFen') && !Object.hasOwn(value, 'category')) {
    throw new Error('INVALID_RECEIPT_PATCH');
  }
  return {
    paidFen: value.paidFen as number | undefined,
    category: value.category as Rule['category'] | undefined,
  };
}

function refundFenFromRequest(body: unknown): number {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('INVALID_REFUND');
  }
  const value = body as Record<string, unknown>;
  if (!Object.hasOwn(value, 'refundFen') || typeof value.refundFen !== 'number') {
    throw new Error('INVALID_REFUND');
  }
  return value.refundFen;
}

function batchRequest(body: unknown): {
  receiptIds: string[];
  options: FormOptions;
} {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('INVALID_BATCH_REQUEST');
  }
  const value = body as Record<string, unknown>;
  if (
    !Array.isArray(value.receiptIds) ||
    !value.receiptIds.every((id) => typeof id === 'string') ||
    value.options === null ||
    typeof value.options !== 'object' ||
    Array.isArray(value.options)
  ) {
    throw new Error('INVALID_BATCH_REQUEST');
  }
  return { receiptIds: value.receiptIds, options: value.options as FormOptions };
}

function batchMoveRequest(body: unknown): {
  category: Category;
  direction: -1 | 1;
} {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('INVALID_MOVE');
  }
  const value = body as Record<string, unknown>;
  if (
    typeof value.category !== 'string' ||
    !CATEGORIES.includes(value.category as Category) ||
    (value.direction !== -1 && value.direction !== 1)
  ) {
    throw new Error('INVALID_MOVE');
  }
  return { category: value.category as Category, direction: value.direction };
}

function batchOptionsRequest(body: unknown): {
  options: FormOptions;
  noteBySheet: Record<string, string | null>;
} {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('INVALID_BATCH_OPTIONS');
  }
  const value = body as Record<string, unknown>;
  if (
    value.options === null ||
    typeof value.options !== 'object' ||
    Array.isArray(value.options) ||
    value.noteBySheet === null ||
    typeof value.noteBySheet !== 'object' ||
    Array.isArray(value.noteBySheet)
  ) {
    throw new Error('INVALID_BATCH_OPTIONS');
  }
  return {
    options: value.options as FormOptions,
    noteBySheet: value.noteBySheet as Record<string, string | null>,
  };
}

function batchHttpError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new HttpError(500, 'INTERNAL_ERROR', '服务器内部错误');
  }
  if (error.message === 'BATCH_NOT_FOUND') {
    return new HttpError(404, 'BATCH_NOT_FOUND', '报销批次不存在');
  }
  if (error.message === 'NOT_ELIGIBLE') {
    return new HttpError(409, 'NOT_ELIGIBLE', '凭证当前状态不可生成');
  }
  if (error.message === 'BATCH_FINALIZED') {
    return new HttpError(409, 'BATCH_FINALIZED', '已导出的报销单不可修改');
  }
  if (
    error.message === 'INVALID_SELECTION' ||
    error.message === 'INVALID_OPTIONS' ||
    error.message === 'INVALID_SIGNATURE' ||
    error.message === 'INVALID_BATCH_REQUEST' ||
    error.message === 'INVALID_AMOUNT' ||
    error.message === 'INVALID_MOVE' ||
    error.message === 'INVALID_LAYOUT' ||
    error.message === 'INVALID_NOTE_BY_SHEET' ||
    error.message === 'INVALID_BATCH_OPTIONS' ||
    error.message === 'LAYOUT_OVERFLOW' ||
    error.message === 'CATEGORY_TOO_LARGE'
  ) {
    return new HttpError(400, error.message, '请求参数无效');
  }
  return error;
}

function correctionHttpError(error: unknown): Error {
  if (!(error instanceof Error)) {
    return new HttpError(500, 'INTERNAL_ERROR', '服务器内部错误');
  }
  if (error.message === 'NOT_FOUND') {
    return new HttpError(404, 'RECEIPT_NOT_FOUND', '凭证不存在');
  }
  if (
    error.message === 'IMMUTABLE_RECEIPT' ||
    error.message === 'INCOMPLETE_RECEIPT' ||
    error.message === 'UNRESOLVED_DUPLICATE'
  ) {
    return new HttpError(409, error.message, '凭证当前状态不可确认');
  }
  if (
    error.message === 'INVALID_CATEGORY' ||
    error.message === 'INVALID_PAID_FEN' ||
    error.message === 'INVALID_REFUND' ||
    error.message === 'INVALID_IMAGE' ||
    error.message === 'INVALID_RECEIPT_PATCH' ||
    error.message.startsWith('INVALID_RULE') ||
    error.message === 'INVALID_CONFIRMATIONS'
  ) {
    return new HttpError(400, error.message, '请求参数无效');
  }
  if (error.message === 'IMAGE_TOO_LARGE') {
    return new HttpError(413, error.message, '上传图片数量或大小超出限制');
  }
  return error;
}

function settingsFromRequest(body: unknown): Settings {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('INVALID_SETTINGS');
  }
  return body as Settings;
}

function noteForCreate(body: unknown): Omit<Note, 'id'> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('INVALID_NOTE');
  }
  const value = body as Record<string, unknown>;
  if (typeof value.name !== 'string' || typeof value.content !== 'string') {
    throw new Error('INVALID_NOTE');
  }
  return { name: value.name, content: value.content };
}

function noteForUpdate(id: string, body: unknown): Note {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('INVALID_NOTE');
  }
  const value = body as Record<string, unknown>;
  if (value.id !== id) {
    throw new Error('INVALID_NOTE_ID');
  }
  return { id, name: value.name as string, content: value.content as string };
}

function settingsHttpError(error: unknown): Error {
  if (error instanceof HttpError) {
    return error;
  }
  if (!(error instanceof Error)) {
    return new HttpError(500, 'INTERNAL_ERROR', '服务器内部错误');
  }
  if (error.message === 'NOTE_NOT_FOUND') {
    return new HttpError(404, 'NOTE_NOT_FOUND', '备注不存在');
  }
  if (
    error.message === 'INVALID_SETTINGS' ||
    error.message === 'INVALID_DATE' ||
    error.message === 'INVALID_SIGNATURE' ||
    error.message === 'INVALID_NOTE' ||
    error.message === 'INVALID_NOTE_ID' ||
    error.message === 'INVALID_IMAGE'
  ) {
    return new HttpError(400, error.message, '请求参数无效');
  }
  if (error.message === 'IMAGE_TOO_LARGE') {
    return new HttpError(413, error.message, '上传图片数量或大小超出限制');
  }
  return error;
}
