import { createHash, randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';

import type { Batch, FileIndexEntry } from '@auto-reimbursement/contracts';
import sharp from 'sharp';

import { assertActiveBatch, getBatch } from '../batches.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { readVerifiedFile, storeExportPdf } from '../storage.js';
import { drawAttachment, orderedAttachments, type Attachment } from './attachments.js';
import { createFormDocument, drawForm } from './form.js';

export async function renderBatchPdf(
  store: Store,
  config: Config,
  batch: Batch,
): Promise<Buffer> {
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
  const fileId = randomUUID();
  let createdPath: string | null = null;
  try {
    const saved = await storeExportPdf(config, existing.month, fileId, bytes);
    const finalRelativePath = saved.path;
    const finalPath = saved.absolutePath;
    createdPath = finalPath;

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
      store.put('batches', updated);
      return updated;
    });
    if (exported.pdfPath !== finalRelativePath) {
      await unlink(finalPath);
    }
    return exported;
  } catch (error) {
    if (createdPath !== null) {
      try {
        await unlink(createdPath);
      } catch {
        // Keep the export failure; this path was created only for this export.
      }
    }
    throw error;
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
    return await pdfImageBytes(bytes);
  } catch {
    throw missingAttachment(attachment.receiptId);
  }
}

function missingAttachment(receiptId: string): Error {
  return new Error(`MISSING_ATTACHMENT:${receiptId}`);
}
