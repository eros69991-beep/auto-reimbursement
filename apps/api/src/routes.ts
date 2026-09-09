import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { Router } from 'express';
import multer from 'multer';
import type { Rule } from '@auto-reimbursement/contracts';

import { getApiStatus } from './ai/openai-compatible.js';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { confirmDistinct } from './duplicates.js';
import { deleteRule, listRules, saveRule } from './learning.js';
import { getProgress, type RecognitionQueue } from './queue.js';
import { confirmReceipt, updateReceipt, uploadReceipts } from './receipts.js';
import { addRefundImage, setRefund } from './refunds.js';
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
