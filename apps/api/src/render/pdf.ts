import { createHash, randomUUID } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';

import type { Batch, FileIndexEntry, ImageRef } from '@auto-reimbursement/contracts';
import sharp from 'sharp';

import { getBatch } from '../batches.js';
import type { Config } from '../config.js';
import type { Store } from '../db.js';
import { safePath, storeExportPdf } from '../storage.js';
import { drawAttachment, orderedAttachments, type Attachment } from './attachments.js';
import { createFormDocument, drawForm } from './form.js';

export async function renderBatchPdf(config: Config, batch: Batch): Promise<Buffer> {
  const doc = createFormDocument();
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    doc.once('error', reject);
  });

  try {
    const signature = await readSignatureBytes(config, batch);
    for (const sheet of batch.sheets) {
      drawForm(doc, batch, sheet, signature);
      for (const attachment of orderedAttachments(batch, sheet)) {
        const bytes = await attachmentBytes(config, attachment);
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
  if (existing.pdfPath !== null) {
    return existing;
  }

  const bytes = await renderBatchPdf(config, existing);
  const fileId = randomUUID();
  let createdPath: string | null = null;
  try {
    const saved = await storeExportPdf(config, existing.month, fileId, bytes);
    const finalRelativePath = saved.path;
    const finalPath = saved.absolutePath;
    createdPath = finalPath;

    const exported = store.transact(() => {
      const current = getBatch(store, id);
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

async function readSignatureBytes(config: Config, batch: Batch): Promise<Buffer | null> {
  if (batch.options.signerMode === 'text') {
    return null;
  }
  if (batch.options.signature === null || batch.options.signature.deletedAt !== null) {
    throw new Error('MISSING_ATTACHMENT');
  }
  try {
    return await readFile(safePath(config.dataDir, batch.options.signature.path));
  } catch {
    throw new Error('MISSING_ATTACHMENT');
  }
}

async function attachmentBytes(config: Config, attachment: Attachment): Promise<Buffer> {
  if (attachment.image.deletedAt !== null) {
    throw missingAttachment(attachment.receiptId);
  }
  let bytes: Buffer;
  try {
    bytes = await readFile(safePath(config.dataDir, attachment.image.path));
  } catch {
    throw missingAttachment(attachment.receiptId);
  }
  if (attachment.image.mime !== 'image/webp') {
    return bytes;
  }
  try {
    return await sharp(bytes).png().toBuffer();
  } catch {
    throw missingAttachment(attachment.receiptId);
  }
}

function missingAttachment(receiptId: string): Error {
  return new Error(`MISSING_ATTACHMENT:${receiptId}`);
}
