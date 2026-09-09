import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { Router } from 'express';
import multer from 'multer';

import { getApiStatus } from './ai/openai-compatible.js';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { confirmDistinct } from './duplicates.js';
import { getProgress, type RecognitionQueue } from './queue.js';
import { uploadReceipts } from './receipts.js';
import { safePath } from './storage.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fields: 0, files: 50, fileSize: MAX_IMAGE_BYTES },
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
