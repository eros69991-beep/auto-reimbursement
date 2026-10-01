import { createHash, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

import type { Batch, FileIndexEntry } from '@auto-reimbursement/contracts';
import sharp from 'sharp';

import { assertActiveBatch, getBatch } from '../batches.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { logger } from '../logger.js';
import { readVerifiedFile, storeExportPdf } from '../storage.js';
import { drawAttachment, orderedAttachments, type Attachment } from './attachments.js';
import { createFormDocument, drawForm } from './form.js';

export async function renderBatchPdf(
  store: Store,
  config: Config,
  batch: Batch,
  options: { attachments?: boolean } = {},
): Promise<Buffer> {
  // P-16：草稿预览可只渲染表单页（attachments=false），附件原图在对账页单独展示
  const withAttachments = options.attachments ?? true;
  assertActiveBatch(batch);
  const doc = createFormDocument();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    doc.once('error', reject);
  });

  try {
    const signature = await readSignatureBytes(store, config, batch);
    for (const sheet of batch.sheets) {
      drawForm(doc, batch, sheet, signature);
      if (!withAttachments) continue;
      for (const attachment of orderedAttachments(batch, sheet)) {
        const bytes = await attachmentBytes(store, config, attachment);
        drawAttachment(doc, attachment, bytes);
      }
    }
    doc.end();
  } catch (error) {
    doc.destroy(error instanceof Error ? error : new Error(String(error)));
  }
  return done;
}

export async function exportBatchPdf(
  store: Store,
  config: Config,
  id: string,
): Promise<Batch> {
  const existing = getBatch(store, id);
  assertActiveBatch(existing);
  if (existing.pdfPath !== null) {
    return existing;
  }

  const bytes = await renderBatchPdf(store, config, existing);
  // 对账页预览只需要报销单页：顺手多存一份几十 KB 的小文件，免得手机/慢网下为了看报销单去下整份几 MB 的 PDF。
  // 它只是加速用的副本：渲染或保存失败不能挡住导出，预览会退回整份 PDF。
  const formBytes = await renderFormCopy(store, config, existing);
  const fileId = randomUUID();
  const formFileId = `${fileId}-form`;
  const createdPaths: string[] = [];
  try {
    const saved = await storeExportPdf(config, existing.month, fileId, bytes);
    const finalRelativePath = saved.path;
    createdPaths.push(saved.absolutePath);
    const savedForm = formBytes === null ? null : await storeFormCopy(config, existing.month, formFileId, formBytes);
    if (savedForm !== null) {
      createdPaths.push(savedForm.absolutePath);
    }

    const exported = store.transact(() => {
      const current = getBatch(store, id);
      assertActiveBatch(current);
      if (current.pdfPath !== null) {
        return current;
      }
      const entry: FileIndexEntry = {
        id: fileId,
        ownerId: current.id,
        kind: 'pdf',
        path: finalRelativePath,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        deletedAt: null,
      };
      const updated = { ...current, pdfPath: finalRelativePath };
      store.put('files', entry);
      if (savedForm !== null && formBytes !== null) {
        store.put('files', {
          id: formFileId,
          ownerId: current.id,
          kind: 'pdf-form',
          path: savedForm.path,
          sha256: createHash('sha256').update(formBytes).digest('hex'),
          deletedAt: null,
        });
      }
      store.put('batches', updated);
      return updated;
    });
    if (exported.pdfPath !== finalRelativePath) {
      // 别的请求先一步定稿了：这次多写的文件都不要
      for (const path of createdPaths) {
        await unlink(path);
      }
    }
    return exported;
  } catch (error) {
    for (const path of createdPaths) {
      try {
        await unlink(path);
      } catch {
        // Keep the export failure; these paths were created only for this export.
      }
    }
    throw error;
  }
}

async function renderFormCopy(store: Store, config: Config, batch: Batch): Promise<Buffer | null> {
  try {
    return await renderBatchPdf(store, config, batch, { attachments: false });
  } catch (error) {
    logger.warn({ err: error, batchId: batch.id }, '导出时没能生成「仅报销单页」预览副本，预览将使用整份 PDF');
    return null;
  }
}

async function storeFormCopy(
  config: Config,
  month: string,
  id: string,
  bytes: Buffer,
): Promise<{ path: string; absolutePath: string } | null> {
  try {
    return await storeExportPdf(config, month, id, bytes);
  } catch (error) {
    logger.warn({ err: error, id }, '导出时没能保存「仅报销单页」预览副本，预览将使用整份 PDF');
    return null;
  }
}

/** 定稿批次导出时存下的「仅报销单页」副本（索引项）；老批次导出时还没有这份，返回 null。 */
export function findSavedFormPdf(store: Store, batch: Batch): FileIndexEntry | null {
  if (batch.pdfPath === null) {
    return null;
  }
  const entries = store.list('files').filter((entry) => (
    entry.ownerId === batch.id &&
    entry.kind === 'pdf-form' &&
    entry.deletedAt === null
  ));
  return entries.length === 1 ? entries[0]! : null;
}

/** 读副本并核对哈希；文件丢了或被换过返回 null（调用方退回整份 PDF）。 */
export async function readSavedFormPdf(config: Config, entry: FileIndexEntry): Promise<Buffer | null> {
  try {
    return await readVerifiedFile(config, entry);
  } catch {
    return null;
  }
}

export async function readSavedBatchPdf(
  store: Store,
  config: Config,
  batch: Batch,
): Promise<Buffer> {
  if (batch.pdfPath === null) {
    throw new Error('PDF_NOT_FOUND');
  }
  const entries = store.list('files').filter((entry) => (
    entry.ownerId === batch.id &&
    entry.kind === 'pdf' &&
    entry.path === batch.pdfPath &&
    entry.deletedAt === null
  ));
  if (entries.length !== 1) {
    throw new Error('PDF_NOT_FOUND');
  }
  try {
    return await readVerifiedFile(config, entries[0]!);
  } catch {
    throw new Error('PDF_NOT_FOUND');
  }
}

async function readSignatureBytes(
  store: Store,
  config: Config,
  batch: Batch,
): Promise<Buffer | null> {
  if (batch.options.signerMode === 'text') {
    return null;
  }
  if (batch.options.signature === null) {
    throw new Error('MISSING_ATTACHMENT');
  }
  const entry = store.get('files', batch.options.signature.id);
  if (
    entry === null ||
    entry.ownerId !== 'default' ||
    entry.kind !== 'signature' ||
    entry.deletedAt !== null
  ) {
    throw new Error('MISSING_ATTACHMENT');
  }
  try {
    return await pdfImageBytes(await readVerifiedFile(config, entry));
  } catch {
    throw new Error('MISSING_ATTACHMENT');
  }
}

async function pdfImageBytes(bytes: Buffer): Promise<Buffer> {
  try {
    const metadata = await sharp(bytes).metadata();
    if (metadata.format === 'webp') {
      return await sharp(bytes).png().toBuffer();
    }
    if (metadata.format === 'jpeg' || metadata.format === 'png') {
      return bytes;
    }
  } catch {
    // The caller must expose only the stable attachment error.
  }
  throw new Error('INVALID_IMAGE');
}

async function attachmentBytes(
  store: Store,
  config: Config,
  attachment: Attachment,
): Promise<Buffer> {
  const entry = store.get('files', attachment.image.id);
  if (
    entry === null ||
    entry.ownerId !== attachment.receiptId ||
    entry.kind !== attachment.kind ||
    entry.deletedAt !== null
  ) {
    throw missingAttachment(attachment.receiptId);
  }
  let bytes: Buffer;
  try {
    bytes = await readVerifiedFile(config, entry);
  } catch {
    throw missingAttachment(attachment.receiptId);
  }
  try {
    return await attachmentImageBytes(bytes);
  } catch {
    throw missingAttachment(attachment.receiptId);
  }
}

// P-16：嵌入 PDF 前按 EXIF 自动旋转并降到长边 1600px、JPEG q80，
// 每页约 0.3 MB（原样嵌入 12MP 原图时每页约 2 MB），磁盘上的原图保持不变。
async function attachmentImageBytes(bytes: Buffer): Promise<Buffer> {
  try {
    return await sharp(bytes)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch {
    throw new Error('INVALID_IMAGE');
  }
}

function missingAttachment(receiptId: string): Error {
  return new Error(`MISSING_ATTACHMENT:${receiptId}`);
}
