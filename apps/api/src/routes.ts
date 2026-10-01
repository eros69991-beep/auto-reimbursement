import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

import { Router } from 'express';
import multer from 'multer';
import {
  ALL_CATEGORIES,
  isLedger,
  type Category,
  type FormOptions,
  type Ledger,
  type Note,
  type Rule,
  type Settings,
} from '@auto-reimbursement/contracts';

import { getApiStatus } from './ai/openai-compatible.js';
import { archiveMonth, cleanOriginals, history, unarchiveMonth } from './archive.js';
import { backupAll } from './backup.js';
import {
  createBatch,
  createBatchNote,
  cancelBatch,
  assertActiveBatch,
  getBatch,
  moveBatchGroup,
  poolTotals,
  updateBatchNote,
  updateBatchOptions,
} from './batches.js';
import type { Config } from './config.js';
import type { Store } from './db.js';
import { reapplyRules } from './decision.js';
import { HttpError, toHttpError } from './errors.js';
import { logger } from './logger.js';
import { confirmDistinct } from './duplicates.js';
import { deleteRule, listRules, saveRule } from './learning.js';
import { mergeReceipts, splitReceipt } from './merge.js';
import { getProgress, type RecognitionQueue } from './queue.js';
import {
  exportBatchPdf,
  findSavedFormPdf,
  readSavedBatchPdf,
  readSavedFormPdf,
  renderBatchPdf,
} from './render/pdf.js';
import {
  confirmReceipt,
  deleteReceipt,
  listReceipts,
  restoreReceipt,
  setPoolMembership,
  updateReceipt,
  uploadReceipts,
  type ReceiptPatch,
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
import { thumbnailWebp, viewJpeg } from './thumbs.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// P-12：凭证上传的 multer 上限放宽到 25MB，让 20–25MB 的文件进入按文件拒绝流程
// （storeImage 仍按 20MB 拒绝单个文件并继续处理其余文件），不再整单 413。
// 内存上界 50 x 25 MiB；超过 25MB 的恶意/异常文件仍整单 413。
const UPLOAD_MULTER_FILE_SIZE = 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fields: 0, files: 50, fileSize: UPLOAD_MULTER_FILE_SIZE },
});
const refundUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fields: 0, files: 1, fileSize: MAX_IMAGE_BYTES },
});
const signatureUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fields: 0, fileSize: MAX_IMAGE_BYTES },
});

export { HttpError } from './errors.js';

export function createRouter(
  store: Store,
  config: Config,
  queue?: RecognitionQueue,
): Router {
  const router = Router();

  // P-18：部署版本核对——返回 Railway 注入的 commit SHA，本地开发为 null
  router.get('/version', (_request, response) => {
    response.json({ commit: config.commitSha });
  });

  router.get('/ai/status', (_request, response) => {
    response.json(getApiStatus(config));
  });

  // 历史、归档、清理、凭证列表、汇总、规则都按「区」分开：?ledger=company 是公账付款，不带就是店内报销
  router.get('/history', (request, response, next) => {
    try { response.json(history(store, ledgerFromQuery(request.query.ledger))); }
    catch (error) { next(maintenanceHttpError(error)); }
  });

  router.post('/archive/:month', (request, response, next) => {
    try { response.json(archiveMonth(store, request.params.month, new Date(), ledgerFromQuery(request.query.ledger))); }
    catch (error) { next(maintenanceHttpError(error)); }
  });

  router.post('/unarchive/:month', (request, response, next) => {
    try { response.json(unarchiveMonth(store, request.params.month, ledgerFromQuery(request.query.ledger))); }
    catch (error) { next(maintenanceHttpError(error)); }
  });

  router.post('/cleanup/:month', async (request, response, next) => {
    try {
      const confirmation = request.body?.confirmation;
      if (typeof confirmation !== 'string') throw new Error('INVALID_CLEANUP_CONFIRMATION');
      response.json(await cleanOriginals(store, config, request.params.month, confirmation, ledgerFromQuery(request.query.ledger)));
    } catch (error) { next(maintenanceHttpError(error)); }
  });

  router.post('/backup', async (_request, response, next) => {
    try {
      const result = await backupAll(store, config);
      const id = result.path.slice('backups/'.length, -'.zip'.length);
      response.status(201).json({ downloadUrl: `/api/backups/${encodeURIComponent(id)}`, includesImages: false });
    } catch (error) { next(maintenanceHttpError(error)); }
  });

  router.get('/backups/:id', async (request, response, next) => {
    try {
      const path = store.getBackup?.(request.params.id) ?? null;
      if (path === null) throw new Error('BACKUP_NOT_FOUND');
      const stream = createReadStream(safePath(config.dataDir, path));
      stream.once('error', next);
      response.type('application/zip').attachment(`${request.params.id}.zip`);
      stream.pipe(response);
    } catch (error) { next(maintenanceHttpError(error)); }
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
    if (request.query.view !== 'pool' && request.query.view !== 'pending' && request.query.view !== 'excluded' && request.query.view !== 'deleted') {
      next(new HttpError(400, 'INVALID_RECEIPT_VIEW', '请求参数无效'));
      return;
    }
    try { response.json(listReceipts(store, request.query.view, ledgerFromQuery(request.query.ledger))); }
    catch (error) { next(error); }
  });

  router.get('/pool/totals', (request, response, next) => {
    try { response.json(poolTotals(store.list('receipts'), ledgerFromQuery(request.query.ledger))); }
    catch (error) { next(error); }
  });

  router.delete('/receipts/:id', (request, response, next) => {
    try {
      deleteReceipt(store, request.params.id, new Date());
      response.status(204).end();
    } catch (error) {
      next(correctionHttpError(error));
    }
  });

  router.post('/receipts/:id/restore', (request, response, next) => {
    try {
      const receipt = restoreReceipt(store, request.params.id);
      if (receipt.status === 'recognizing') queue?.enqueue([receipt.id]);
      response.json(receipt);
    } catch (error) { next(correctionHttpError(error)); }
  });

  // 同一单被截成几张图：把 2–3 张拼成一张重新识别；来源截图隐藏起来，随时可以「拆开」
  router.post('/receipts/merge', async (request, response, next) => {
    try {
      const receiptIds: unknown = request.body?.receiptIds;
      if (!Array.isArray(receiptIds) || receiptIds.some((id) => typeof id !== 'string')) {
        throw new Error('INVALID_MERGE');
      }
      const merged = await mergeReceipts(store, config, receiptIds as string[], new Date());
      queue?.enqueue([merged.id]);
      response.status(201).json(merged);
    } catch (error) { next(correctionHttpError(error)); }
  });

  router.post('/receipts/:id/split', async (request, response, next) => {
    try {
      response.json(await splitReceipt(store, config, request.params.id));
    } catch (error) { next(correctionHttpError(error)); }
  });

  router.post('/receipts/:id/pool', (request, response, next) => {
    try {
      if (typeof request.body?.included !== 'boolean') throw new Error('INVALID_RECEIPT_PATCH');
      response.json(setPoolMembership(store, request.params.id, request.body.included));
    } catch (error) { next(correctionHttpError(error)); }
  });

  router.post('/batches/:id/cancel', (request, response, next) => {
    try { response.json(cancelBatch(store, request.params.id, new Date())); }
    catch (error) { next(batchHttpError(error)); }
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

  // P-16：草稿预览渲染结果按内容哈希缓存（单用户单批次，内存一份即可）
  const previewCache = new Map<string, { key: string; bytes: Buffer }>();

  router.get('/batches/:id/preview.pdf', async (request, response, next) => {
    try {
      const batch = getBatch(store, request.params.id);
      assertActiveBatch(batch);
      if (batch.pdfPath !== null) {
        // 定稿后的预览只需要报销单页：导出时存了「仅报销单页」的小文件（几十 KB），优先给它，
        // 手机和慢网下就不必为了看报销单去下整份含全部凭证页的 PDF。老批次导出时还没有这份，退回整份。
        const formEntry = findSavedFormPdf(store, batch);
        if (formEntry !== null) {
          const formEtag = `"saved-form-${formEntry.sha256.slice(0, 24)}"`;
          if (request.get('if-none-match') === formEtag) {
            response.status(304).end();
            return;
          }
          const form = await readSavedFormPdf(config, formEntry);
          if (form !== null) {
            response
              .set('Cache-Control', 'private, max-age=31536000, immutable')
              .set('ETag', formEtag)
              .type('application/pdf')
              .send(form);
            return;
          }
          // 副本丢了或被换过：退回整份
        }
        // 定稿 PDF 内容不可变，可以长缓存
        const etag = `"saved-${createHash('sha256').update(batch.pdfPath).digest('hex').slice(0, 24)}"`;
        if (request.get('if-none-match') === etag) {
          response.status(304).end();
          return;
        }
        const bytes = await readSavedBatchPdf(store, config, batch);
        response
          .set('Cache-Control', 'private, max-age=31536000, immutable')
          .set('ETag', etag)
          .type('application/pdf')
          .send(bytes);
        return;
      }
      // P-16：草稿预览默认只渲染表单页（?attachments=1 才带附件页）；
      // 按内容哈希缓存渲染结果并返回 ETag，内容未变时 304。
      const withAttachments = request.query.attachments === '1';
      const cacheKey = createHash('sha256')
        .update(JSON.stringify({ batch, withAttachments }))
        .digest('hex')
        .slice(0, 32);
      const etag = `"preview-${cacheKey}"`;
      if (request.get('if-none-match') === etag) {
        response.status(304).end();
        return;
      }
      // 只缓存「仅报销单页」的轻量预览；含凭证页的完整预览可能几十 MB，不常驻内存（浏览器侧仍有 ETag）
      const cached = withAttachments ? undefined : previewCache.get(batch.id);
      const bytes = cached !== undefined && cached.key === cacheKey
        ? cached.bytes
        : await renderBatchPdf(store, config, batch, { attachments: withAttachments });
      if (!withAttachments) previewCache.set(batch.id, { key: cacheKey, bytes });
      response
        .set('Cache-Control', 'private, no-cache')
        .set('ETag', etag)
        .type('application/pdf')
        .send(bytes);
    } catch (error) {
      next(batchHttpError(error));
    }
  });

  router.post('/batches/:id/export', async (request, response, next) => {
    try {
      response.json(await exportBatchPdf(store, config, request.params.id));
    } catch (error) {
      next(batchHttpError(error));
    }
  });

  router.get('/batches/:id/pdf', async (request, response, next) => {
    try {
      const batch = getBatch(store, request.params.id);
      response.type('application/pdf').send(await readSavedBatchPdf(store, config, batch));
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

  router.post('/batches/:id/notes', (request, response, next) => {
    try {
      const body = (request.body ?? {}) as { name?: unknown; content?: unknown };
      response
        .status(201)
        .json(createBatchNote(store, request.params.id, { name: body.name, content: body.content }));
    } catch (error) {
      next(batchHttpError(error));
    }
  });

  router.put('/batches/:id/notes/:noteId', (request, response, next) => {
    try {
      const body = (request.body ?? {}) as { name?: unknown; content?: unknown };
      response.json(
        updateBatchNote(store, request.params.id, request.params.noteId, {
          name: body.name,
          content: body.content,
        }),
      );
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
        // 上传请求不允许带表单字段（multer fields: 0），区域用查询参数传：/receipts/upload?ledger=company
        const ledger = ledgerFromQuery(request.query.ledger);
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
          ledger,
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
      if (entry === null || entry.kind === 'pdf' || entry.kind === 'pdf-form') {
        throw new HttpError(404, 'IMAGE_NOT_FOUND', '图片不存在');
      }
      if (entry.deletedAt !== null) {
        throw new HttpError(410, 'IMAGE_DELETED', '图片已删除');
      }

      // P-13：列表缩略图（320px WebP，按内容哈希磁盘缓存，内容不可变故 immutable）
      if (request.query.size === 'thumb') {
        try {
          const thumb = await thumbnailWebp(
            config.dataDir,
            entry.sha256,
            safePath(config.dataDir, entry.path),
          );
          response.set('Cache-Control', 'private, max-age=31536000, immutable');
          response.type('webp').send(thumb);
        } catch (error) {
          if (error instanceof Error && error.message.includes('Input file is missing')) {
            throw new HttpError(404, 'IMAGE_NOT_FOUND', '图片不存在');
          }
          throw error;
        }
        return;
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

  router.get('/receipts/:id/original-image', async (request, response, next) => {
    try {
      const receipt = store.get('receipts', request.params.id);
      if (receipt === null) {
        throw new HttpError(404, 'RECEIPT_NOT_FOUND', '凭证不存在');
      }
      const entry = store.get('files', receipt.original.id);
      if (
        entry === null ||
        entry.kind !== 'original' ||
        entry.ownerId !== receipt.id ||
        entry.path !== receipt.original.path
      ) {
        throw new HttpError(404, 'IMAGE_NOT_FOUND', '图片不存在');
      }
      if (entry.deletedAt !== null) {
        throw new HttpError(410, 'IMAGE_DELETED', '图片已删除');
      }
      const sourcePath = safePath(config.dataDir, entry.path);
      // 对账页用 ?size=view：大图给缩小版（手机和慢网下少等几 MB），小图原样返回
      if (request.query.size === 'view') {
        const view = await viewJpeg(config.dataDir, entry.sha256, sourcePath);
        if (view !== null) {
          response.type('jpeg').send(view);
          return;
        }
      }
      response.type(extname(entry.path)).send(await readFile(sourcePath));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        next(new HttpError(404, 'IMAGE_NOT_FOUND', '图片不存在'));
        return;
      }
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
      response.json(confirmReceipt(store, request.params.id, confirmPatchFromRequest(request.body)));
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

  // 不带 ledger 返回全部规则；带了只返回那个区的（规则属于哪个区由它的分类决定）
  router.get('/rules', (request, response, next) => {
    try {
      const ledger = request.query.ledger === undefined ? undefined : ledgerFromQuery(request.query.ledger);
      response.json(listRules(store, ledger));
    } catch (error) {
      next(correctionHttpError(error));
    }
  });

  // 规则改动后，对仍保持识别原样的待处理凭证重新套用规则（不调用 AI）；带 ledger 就只处理那个区的
  router.post('/rules/reapply', (request, response, next) => {
    try {
      const ledger = request.query.ledger === undefined ? undefined : ledgerFromQuery(request.query.ledger);
      response.json({ affected: reapplyRules(store, ledger) });
    } catch (error) {
      next(correctionHttpError(error));
    }
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

/** 请求里的区域：不带就是店内报销；只认 store / company，别的值返回 400。 */
function ledgerFromQuery(value: unknown): Ledger {
  if (value === undefined) return 'store';
  if (isLedger(value)) return value;
  throw new HttpError(400, 'INVALID_LEDGER', '请求参数无效');
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
    typeof value.strong !== 'boolean' ||
    (value.source !== undefined && value.source !== 'manual' && value.source !== 'learned')
  ) {
    throw new Error('INVALID_RULE');
  }
  const rule: Rule = {
    id,
    kind: value.kind,
    key: value.key,
    originalCategory: value.originalCategory as Rule['originalCategory'],
    category: value.category as Rule['category'],
    confirmations: value.confirmations,
    strong: value.strong,
    updatedAt: new Date().toISOString(),
  };
  if (value.source !== undefined) {
    rule.source = value.source;
  }
  return rule;
}

// P-11：PATCH/confirm 除 paidFen/category 外还接受 merchant（≤50 字）和 date（YYYY-MM-DD）
function receiptPatchFromRequest(body: unknown): ReceiptPatch {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('INVALID_RECEIPT_PATCH');
  }
  const value = body as Record<string, unknown>;
  if (
    !Object.hasOwn(value, 'paidFen') &&
    !Object.hasOwn(value, 'category') &&
    !Object.hasOwn(value, 'merchant') &&
    !Object.hasOwn(value, 'date')
  ) {
    throw new Error('INVALID_RECEIPT_PATCH');
  }
  if (value.merchant !== undefined && typeof value.merchant !== 'string') {
    throw new Error('INVALID_MERCHANT');
  }
  if (value.date !== undefined && typeof value.date !== 'string') {
    throw new Error('INVALID_DATE');
  }
  return {
    paidFen: value.paidFen as number | undefined,
    category: value.category as Rule['category'] | undefined,
    merchant: value.merchant as string | undefined,
    date: value.date as string | undefined,
  };
}

// P-10：confirm 可携带可选的修改（paidFen/category/merchant/date），空 body 表示只确认不修改
function confirmPatchFromRequest(body: unknown): ReceiptPatch {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('INVALID_RECEIPT_PATCH');
  }
  if (Object.keys(body as Record<string, unknown>).length === 0) return {};
  return receiptPatchFromRequest(body);
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
    !ALL_CATEGORIES.includes(value.category as Category) ||
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

// 错误码 → HTTP 的集中映射见 errors.ts（P-20）；这里只保留路由上下文特有的文案覆盖。
function batchHttpError(error: unknown): Error {
  if (
    error instanceof Error &&
    (error.message === 'FORM_TEXT_OVERFLOW' || error.message === 'FORM_AMOUNT_OVERFLOW')
  ) {
    logger.error({ err: error }, '报销单版式溢出');
  }
  return toHttpError(error, {
    NOTE_NOT_FOUND: { status: 404, message: '批次内备注不存在' },
    ORIGINAL_CLEANED: { status: 409, message: '原始图片已永久清理，不能恢复报销；请先从备份恢复' },
  });
}

function correctionHttpError(error: unknown): Error {
  return toHttpError(error);
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
  return toHttpError(error);
}

function maintenanceHttpError(error: unknown): Error {
  return toHttpError(error);
}
